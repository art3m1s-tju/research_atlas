import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import { closeSync, mkdirSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";
import { translationDirectory, translationSourceHash, translationUrlCandidates } from "@/lib/paper-translation";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");

function paperFromId(db: Database.Database, id: string) {
  return db.prepare("SELECT id, title, abstract, pdf_url, doi, arxiv_id, normalized_title FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as any;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = paperFromId(db, id);
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const row = db.prepare("SELECT status, source_url, output_dir, error, source_chars, translated_chars, updated_at FROM paper_translations WHERE paper_id = ?").get(paper.id) as any;
    const file = new URL(request.url).searchParams.get("file");
    if (file) {
      if (!row?.output_dir || !["source.md", "translation_zh.md", "glossary.md", "translation_report.md"].includes(file)) {
        return NextResponse.json({ error: "翻译文件尚未生成" }, { status: 404 });
      }
      const content = await fs.readFile(path.join(process.cwd(), row.output_dir, file), "utf8").catch(() => null);
      if (content === null) return NextResponse.json({ error: "翻译文件不存在" }, { status: 404 });
      return new NextResponse(content, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `inline; filename="${file}"` } });
    }
    return NextResponse.json({ translation: row ? { ...row, translationUrl: row.status === "completed" ? `/api/papers/${encodeURIComponent(id)}/translation?file=translation_zh.md` : null } : null });
  } finally { db.close(); }
}

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = paperFromId(db, id);
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const alternatives = paper.normalized_title
      ? db.prepare("SELECT pdf_url, arxiv_id FROM papers WHERE normalized_title = ? AND id != ?").all(paper.normalized_title, paper.id) as { pdf_url?: string | null; arxiv_id?: string | null }[]
      : [];
    const candidates = translationUrlCandidates(paper, alternatives);
    if (!candidates.length) return NextResponse.json({ error: "这篇论文没有可访问的 PDF，暂时无法生成全文翻译。" }, { status: 400 });
    const sourceHash = translationSourceHash(paper);
    const existing = db.prepare("SELECT status, source_hash, error FROM paper_translations WHERE paper_id = ?").get(paper.id) as any;
    if (existing?.status === "completed" && existing.source_hash === sourceHash) {
      return NextResponse.json({ success: true, cached: true, status: existing.status, message: "已存在同版本中文翻译。" });
    }
    db.prepare("INSERT INTO paper_translations (paper_id, status, source_hash, output_dir, error, updated_at) VALUES (?, 'pending', ?, ?, NULL, CURRENT_TIMESTAMP) ON CONFLICT(paper_id) DO UPDATE SET status = 'pending', source_hash = excluded.source_hash, output_dir = excluded.output_dir, error = NULL, updated_at = CURRENT_TIMESTAMP")
      .run(paper.id, sourceHash, translationDirectory(paper.id));
    mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
    const logDescriptor = openSync(path.join(process.cwd(), "data", `translation-${paper.id}.log`), "a");
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(command, ["tsx", path.join(process.cwd(), "scripts", "translate-paper.ts"), "--paper-id", String(paper.id)], { cwd: process.cwd(), detached: true, stdio: ["ignore", logDescriptor, logDescriptor], env: process.env });
    closeSync(logDescriptor);
    child.unref();
    return NextResponse.json({ success: true, cached: false, status: "pending", message: "翻译任务已在后台启动，可稍后刷新状态。" });
  } finally { db.close(); }
}
