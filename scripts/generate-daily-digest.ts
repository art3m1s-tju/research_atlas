import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureResearchFeatureSchema } from "../src/lib/research-features";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");
const OUTPUT_PATH = process.env.DIGEST_OUTPUT_PATH || path.join(process.cwd(), "data", "daily-digest.md");

async function getRecommendations() {
  const baseUrl = process.env.DIGEST_BASE_URL || "http://127.0.0.1:3100";
  try {
    const response = await fetch(`${baseUrl}/api/daily-recommendations?limit=2&window=all`, { signal: AbortSignal.timeout(8000) });
    if (response.ok) return await response.json();
  } catch {
    // The file digest can still use the last local snapshot when the web app is offline.
  }
  const db = new Database(DB_PATH, { readonly: true });
  try {
    ensureResearchFeatureSchema(db);
    const rows = db.prepare(`
      SELECT s.direction, s.kind, p.openalex_id, p.title, p.year, p.venue, p.pdf_url, p.doi, pd.direction_label
      FROM daily_recommendation_snapshot s
      JOIN papers p ON p.id = s.paper_id
      JOIN paper_directions pd ON pd.paper_id = p.id AND pd.direction = s.direction
      WHERE s.recommendation_date = date('now') AND s.filter_window = 'all'
      ORDER BY s.kind, s.direction, s.rank
    `).all() as any[];
    const groups = new Map<string, any>();
    for (const row of rows) {
      const key = row.kind === "exploration" ? "exploration" : row.direction;
      const group = groups.get(key) || { key, label: row.kind === "exploration" ? "探索邻域" : row.direction_label, papers: [] };
      group.papers.push({ id: row.openalex_id, title: row.title, year: row.year, venue: row.venue, pdfUrl: row.pdf_url, doi: row.doi });
      groups.set(key, group);
    }
    return { directions: [...groups.values()] };
  } finally {
    db.close();
  }
}

function markdown(data: any) {
  const date = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const lines = [`# AI Research Atlas 每日论文推荐`, ``, `生成日期：${date}`, ``];
  if (!data?.directions?.length) {
    lines.push("> 暂无每日推荐。请先在网页中启用研究方向，或收藏/标记几篇论文。");
    return lines.join("\n");
  }
  for (const section of data.directions) {
    lines.push(`## ${section.label}`, ``);
    for (const paper of section.papers || []) {
      const link = paper.pdfUrl || paper.doi || (paper.id?.startsWith("http") ? paper.id : "");
      lines.push(`- **${paper.title}** (${paper.year || "年份未知"})${paper.venue ? ` · ${paper.venue}` : ""}${link ? ` · [打开](${link})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const content = markdown(await getRecommendations());
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, content);
  console.log(`每日摘要已写入：${OUTPUT_PATH}`);
  if (process.env.DIGEST_WEBHOOK_URL) {
    await fetch(process.env.DIGEST_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: content, content }) });
    console.log("已发送到 DIGEST_WEBHOOK_URL");
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: content.slice(0, 3900), disable_web_page_preview: true }) });
    console.log("已发送到 Telegram");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
