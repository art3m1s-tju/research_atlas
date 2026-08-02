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
    const value = trimmed.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  loadLocalEnv();
  const { EMBEDDING_MODEL, embedText, paperEmbeddingText } = await import("../src/lib/semantic-search");
  const db = new Database(process.env.DATABASE_PATH || "./data/atlas.db");
  const columns = new Set(
    (db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name),
  );
  if (!columns.has("embedding")) db.exec("ALTER TABLE papers ADD COLUMN embedding TEXT");
  if (!columns.has("embedding_model")) db.exec("ALTER TABLE papers ADD COLUMN embedding_model TEXT");

  const papers = db.prepare(`
    SELECT id, title, abstract, authors, venue
    FROM papers
    WHERE embedding IS NULL OR embedding_model != ?
    ORDER BY id
  `).all(EMBEDDING_MODEL) as {
    id: number;
    title: string;
    abstract: string | null;
    authors: string | null;
    venue: string | null;
  }[];

  console.log(`需要生成 ${papers.length} 篇论文的语义向量（模型：${EMBEDDING_MODEL}）`);
  const update = db.prepare("UPDATE papers SET embedding = ?, embedding_model = ? WHERE id = ?");
  for (let index = 0; index < papers.length; index += 1) {
    const paper = papers[index];
    const vector = await embedText(paperEmbeddingText(paper));
    update.run(JSON.stringify(vector), EMBEDDING_MODEL, paper.id);
    if ((index + 1) % 10 === 0 || index + 1 === papers.length) {
      console.log(`  ${index + 1}/${papers.length}`);
    }
  }
  db.close();
  console.log("语义向量生成完成");
}

main().catch((error) => {
  console.error("语义向量生成失败:", error);
  process.exitCode = 1;
});
