import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { decodePaperId } from "@/lib/paper-id";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");
const MODEL = process.env.DEEPSEEK_TRANSLATION_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const API_BASE_URL = process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com";

function ensureColumns(db: Database.Database) {
  const columns = new Set((db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name));
  for (const [name, type] of Object.entries({ abstract_zh: "TEXT", abstract_translation_model: "TEXT", abstract_translation_source_hash: "TEXT" })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE papers ADD COLUMN ${name} ${type}`);
  }
}

function sourceHash(paper: { title: string; abstract: string; doi?: string | null }) {
  return createHash("sha256").update([paper.title, paper.abstract, paper.doi || ""].join("\n")).digest("hex");
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = new Database(DB_PATH);
  try {
    ensureColumns(db);
    const paper = db.prepare("SELECT id, title, abstract, doi, abstract_zh, abstract_translation_model, abstract_translation_source_hash FROM papers WHERE openalex_id = ?").get(decodePaperId(id)) as any;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    if (!paper.abstract) return NextResponse.json({ error: "这篇论文没有英文摘要，无法生成中文摘要。" }, { status: 400 });
    const hash = sourceHash(paper);
    if (paper.abstract_zh && paper.abstract_translation_model === MODEL && paper.abstract_translation_source_hash === hash) {
      return NextResponse.json({ abstractZh: paper.abstract_zh, cached: true });
    }
    if (!process.env.DEEPSEEK_API_KEY) return NextResponse.json({ error: "DEEPSEEK_API_KEY 未配置" }, { status: 503 });
    const response = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        thinking: { type: "disabled" },
        temperature: 0.1,
        max_tokens: 5000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "你是严谨的中文科研论文翻译助手。只输出合法 JSON，不要 Markdown 代码围栏。" },
          { role: "user", content: `请完整、忠实地把下面英文论文摘要翻译成简体中文。不要总结、删减、补充或改变数字、公式、模型名、数据集名、指标名和引用信息。输出格式：{"abstract_zh":"完整中文摘要"}\n\n论文标题：${paper.title}\n英文摘要：${paper.abstract}` },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) return NextResponse.json({ error: `DeepSeek ${response.status}: ${(await response.text()).slice(0, 240)}` }, { status: 502 });
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    let abstractZh = "";
    try { abstractZh = JSON.parse(content).abstract_zh; } catch { abstractZh = content; }
    if (typeof abstractZh !== "string" || !abstractZh.trim()) return NextResponse.json({ error: "DeepSeek 未返回中文摘要" }, { status: 502 });
    db.prepare("UPDATE papers SET abstract_zh = ?, abstract_translation_model = ?, abstract_translation_source_hash = ? WHERE id = ?").run(abstractZh.trim(), MODEL, hash, paper.id);
    return NextResponse.json({ abstractZh: abstractZh.trim(), cached: false });
  } finally { db.close(); }
}
