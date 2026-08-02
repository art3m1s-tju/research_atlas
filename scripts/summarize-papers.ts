import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

type Paper = {
  id: number;
  title: string;
  abstract: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  summary_model: string | null;
  summary_source_hash: string | null;
};

type Summary = {
  summary_zh: string;
  innovations_zh: string[];
  method_zh: string;
  results_zh: string;
  limitations_zh: string;
};

loadLocalEnv();

const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_BASE_URL = process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const CONCURRENCY = Math.max(1, Number(process.env.SUMMARY_CONCURRENCY || 8));
const LIMIT = Math.max(0, Number(process.env.SUMMARY_LIMIT || 0));

function ensureSchema(db: Database.Database) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name),
  );
  const additions: Record<string, string> = {
    summary_zh: "TEXT",
    innovations_zh: "TEXT NOT NULL DEFAULT '[]'",
    method_zh: "TEXT",
    results_zh: "TEXT",
    limitations_zh: "TEXT",
    summary_model: "TEXT",
    summary_source_hash: "TEXT",
    summary_updated_at: "TEXT",
    is_relevant: "INTEGER NOT NULL DEFAULT 1",
  };
  for (const [column, type] of Object.entries(additions)) {
    if (!columns.has(column)) db.exec(`ALTER TABLE papers ADD COLUMN ${column} ${type}`);
  }
}

function sourceHash(paper: Paper) {
  return createHash("sha256")
    .update([paper.title, paper.abstract, paper.authors, paper.year, paper.venue, paper.doi].join("\n"))
    .digest("hex");
}

function paperPrompt(paper: Paper) {
  return `请阅读下面的论文元数据和摘要，用中文输出 JSON。只能使用论文明确提供的信息，摘要没有说明的内容写“摘要未说明”，不要编造实验结果、会议、数据集或创新点。

输出格式必须严格是：
{
  "summary_zh": "100字以内的中文速览，说明问题、方法和主要结论",
  "innovations_zh": ["核心创新点1", "核心创新点2"],
  "method_zh": "方法概述",
  "results_zh": "关键实验结果；摘要未说明则写摘要未说明",
  "limitations_zh": "论文明确提到的局限；没有则写摘要未说明"
}

论文标题：${paper.title}
作者：${paper.authors || "摘要未说明"}
年份：${paper.year || "摘要未说明"}
发表渠道：${paper.venue || "摘要未说明"}
DOI：${paper.doi || "摘要未说明"}
摘要：${paper.abstract || "摘要未说明"}`;
}

function normalizeSummary(value: unknown): Summary {
  const data = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const innovations = Array.isArray(data.innovations_zh)
    ? data.innovations_zh.filter((item): item is string => typeof item === "string").slice(0, 3)
    : [];
  return {
    summary_zh: typeof data.summary_zh === "string" ? data.summary_zh.trim() : "摘要未说明",
    innovations_zh: innovations.length ? innovations : ["摘要未说明"],
    method_zh: typeof data.method_zh === "string" ? data.method_zh.trim() : "摘要未说明",
    results_zh: typeof data.results_zh === "string" ? data.results_zh.trim() : "摘要未说明",
    limitations_zh: typeof data.limitations_zh === "string" ? data.limitations_zh.trim() : "摘要未说明",
  };
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function generateSummary(paper: Paper): Promise<Summary> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          thinking: { type: "disabled" },
          messages: [
            { role: "system", content: "你是严谨的中文科研论文阅读助手。请输出合法 JSON，不要输出 Markdown 代码围栏。" },
            { role: "user", content: paperPrompt(paper) },
          ],
          response_format: { type: "json_object" },
          max_tokens: 900,
          stream: false,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        if (![429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`DeepSeek ${response.status}: ${body.slice(0, 300)}`);
        }
        throw new Error(`DeepSeek retryable ${response.status}: ${body.slice(0, 300)}`);
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek returned empty content");
      return normalizeSummary(JSON.parse(content));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  if (!API_KEY) {
    console.log("DEEPSEEK_API_KEY 未配置，跳过中文论文解读生成。");
    return;
  }

  const db = new Database(process.env.DATABASE_PATH || "./data/atlas.db");
  ensureSchema(db);
  const allPapers = db.prepare(`
    SELECT id, title, abstract, authors, year, venue, doi, summary_model, summary_source_hash
    FROM papers
    WHERE is_relevant IS NULL OR is_relevant != 0
    ORDER BY citations DESC, year DESC
  `).all() as Paper[];
  const papers = allPapers
    .filter((paper) => paper.summary_model !== MODEL || paper.summary_source_hash !== sourceHash(paper))
    .slice(0, LIMIT > 0 ? LIMIT : undefined);

  console.log(`准备生成 ${papers.length} 篇中文论文解读，模型=${MODEL}，并发=${CONCURRENCY}`);
  let completed = 0;
  let failed = 0;
  const update = db.prepare(`
    UPDATE papers
    SET summary_zh = ?, innovations_zh = ?, method_zh = ?, results_zh = ?, limitations_zh = ?,
        summary_model = ?, summary_source_hash = ?, summary_updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= papers.length) return;
      const paper = papers[index];
      try {
        const summary = await generateSummary(paper);
        update.run(
          summary.summary_zh,
          JSON.stringify(summary.innovations_zh),
          summary.method_zh,
          summary.results_zh,
          summary.limitations_zh,
          MODEL,
          sourceHash(paper),
          paper.id,
        );
        completed += 1;
        console.log(`  ✓ ${completed}/${papers.length} ${paper.title.slice(0, 55)}`);
      } catch (error) {
        failed += 1;
        console.error(`  ✗ ${paper.title.slice(0, 55)}: ${error instanceof Error ? error.message : error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, papers.length) }, () => worker()));
  db.close();
  console.log(`中文论文解读完成：成功 ${completed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("中文论文解读任务失败:", error);
  process.exitCode = 1;
});
