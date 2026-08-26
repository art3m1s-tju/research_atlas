import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const dataRoot = path.join(process.cwd(), "data");
const generated = [
  "assets",
  "chunks",
  "document.json",
  "source.md",
  "source_structured.md",
  "structure_manifest.json",
  "translation_zh.md",
  "translation_candidate.md",
  "translation_mono.pdf",
  "translation_dual.pdf",
  "pdf2zh_result.json",
  "pdf2zh_glossary.csv",
  "translation_meta.json",
  "translation_report.md",
];

async function main() {
  const roots = [path.join(dataRoot, "translations"), path.join(dataRoot, "translation-runs")];
  let cleared = 0;
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const paperDirectory = path.join(root, entry.name);
      const directories = root.endsWith("translation-runs")
        ? (await fs.readdir(paperDirectory, { withFileTypes: true }).catch(() => []))
          .filter((run) => run.isDirectory())
          .map((run) => path.join(paperDirectory, run.name))
        : [paperDirectory];
      for (const directory of directories) {
        for (const name of generated) {
          await fs.rm(path.join(directory, name), { recursive: true, force: true });
        }
      }
      cleared += 1;
    }
  }
  const dbPath = process.env.DATABASE_PATH || path.join(dataRoot, "atlas.db");
  const db = new Database(dbPath);
  db.prepare("UPDATE paper_translations SET status = 'pending', error = NULL, progress_phase = 'queued', progress_current = 0, progress_total = 0, progress_message = '旧缓存已失效，等待新翻译管线启动', translated_chars = 0, updated_at = CURRENT_TIMESTAMP").run();
  db.close();
  console.log(`已失效 ${cleared} 个论文翻译缓存目录；保留原始 source.pdf。`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
