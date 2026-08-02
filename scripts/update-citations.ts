import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const API_KEY = process.env.OPENALEX_API_KEY;
const DB_PATH = process.env.DATABASE_PATH || "./data/atlas.db";
const LIMIT = Math.max(0, Number(process.env.CITATION_UPDATE_LIMIT || 200));
const CONCURRENCY = Math.max(1, Number(process.env.CITATION_UPDATE_CONCURRENCY || 8));

async function fetchWork(id: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`https://api.openalex.org/works/${encodeURIComponent(id)}?select=id,cited_by_count,cited_by_percentile_year&api_key=${encodeURIComponent(API_KEY || "")}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.ok) return await response.json() as any;
      if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`OpenAlex ${response.status}`);
      lastError = new Error(`OpenAlex ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  if (!API_KEY) {
    console.log("OPENALEX_API_KEY 未配置，跳过引用量增量更新。");
    return;
  }

  const db = new Database(DB_PATH);
  const columns = new Set((db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name));
  if (!columns.has("citations_updated_at")) db.exec("ALTER TABLE papers ADD COLUMN citations_updated_at TEXT");
  const papers = db.prepare(`
    SELECT id, openalex_id, citations
    FROM papers
    WHERE openalex_id LIKE 'https://openalex.org/%'
    ORDER BY citations_updated_at IS NULL DESC, citations_updated_at ASC
    LIMIT ?
  `).all(LIMIT > 0 ? LIMIT : -1) as { id: number; openalex_id: string; citations: number | null }[];

  console.log(`准备更新 ${papers.length} 篇论文的引用量，并发=${CONCURRENCY}`);
  const update = db.prepare("UPDATE papers SET citations = ?, citation_percentile = ?, citations_updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  let cursor = 0;
  let completed = 0;
  let changed = 0;
  let failed = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= papers.length) return;
      const paper = papers[index];
      try {
        const work = await fetchWork(paper.openalex_id.replace(/^https?:\/\/openalex.org\//, ""));
        const citations = Number(work.cited_by_count || 0);
        const percentile = work.cited_by_percentile_year?.max || work.cited_by_percentile_year?.min || null;
        update.run(citations, percentile, paper.id);
        if (citations !== (paper.citations || 0)) changed += 1;
        completed += 1;
        if (completed % 25 === 0 || completed === papers.length) console.log(`  ${completed}/${papers.length}`);
      } catch (error) {
        failed += 1;
        console.error(`  引用更新失败 ${paper.openalex_id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, papers.length) }, () => worker()));
  db.close();
  console.log(`引用量更新完成：处理 ${completed}，发生变化 ${changed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("引用量增量更新失败:", error);
  process.exitCode = 1;
});
