import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

export async function GET() {
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const labels = db.prepare(`
      SELECT label, COUNT(*) AS count
      FROM paper_relevance_feedback
      WHERE created_at >= datetime('now', '-90 day')
      GROUP BY label
    `).all();
    const directions = db.prepare(`
      SELECT direction,
        COUNT(*) AS total,
        SUM(CASE WHEN label = 'relevant' THEN 1 ELSE 0 END) AS relevant,
        SUM(CASE WHEN label = 'partial' THEN 1 ELSE 0 END) AS partial,
        SUM(CASE WHEN label = 'irrelevant' THEN 1 ELSE 0 END) AS irrelevant
      FROM paper_relevance_feedback
      WHERE created_at >= datetime('now', '-90 day')
      GROUP BY direction
      ORDER BY total DESC
    `).all();
    const interactions = db.prepare(`
      SELECT event, COUNT(*) AS count
      FROM paper_user_events
      WHERE created_at >= datetime('now', '-30 day')
      GROUP BY event
    `).all();
    return NextResponse.json({
      period: "90d labels / 30d interactions",
      labels,
      directions,
      interactions,
      guidance: "当相关标注累计到 50 篇以上后，可以据此调整方向关键词、负向规则和推荐权重。",
    });
  } finally {
    db.close();
  }
}
