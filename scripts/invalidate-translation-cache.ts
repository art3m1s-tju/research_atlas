import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.join(process.cwd(), "data", "translations");
const generated = [
  "assets",
  "chunks",
  "document.json",
  "source.md",
  "source_structured.md",
  "structure_manifest.json",
  "translation_zh.md",
  "translation_candidate.md",
  "translation_meta.json",
  "translation_report.md",
];

async function main() {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  let cleared = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    for (const name of generated) {
      await fs.rm(path.join(directory, name), { recursive: true, force: true });
    }
    cleared += 1;
  }
  const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE paper_translations SET status = 'pending', error = NULL, progress_phase = 'queued', progress_current = 0, progress_total = 0, progress_message = '旧缓存已失效，等待新翻译管线启动', translated_chars = 0, updated_at = CURRENT_TIMESTAMP").run();
  db.close();
  console.log(`已失效 ${cleared} 个论文翻译缓存目录；保留原始 source.pdf。`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
