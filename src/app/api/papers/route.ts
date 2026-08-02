import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

const BUILTIN_DIRECTION_META: Record<string, { label: string; color: string }> = {
  e2e: { label: "端到端自动驾驶", color: "#3b82f6" },
  planning: { label: "运动规划与控制", color: "#14b8a6" },
  world_model: { label: "驾驶世界模型", color: "#b45309" },
  llm_driving: { label: "大模型+驾驶", color: "#8b5cf6" },
  control: { label: "车辆控制", color: "#ef4444" },
  perception: { label: "BEV感知", color: "#2563eb" },
  prediction: { label: "轨迹预测", color: "#e11d48" },
  rl_driving: { label: "强化学习驾驶", color: "#65a30d" },
  racing: { label: "自动驾驶竞赛", color: "#f43f5e" },
  safety: { label: "安全验证", color: "#6b7280" },
};

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const direction = searchParams.get("direction") || "all";
  const search = searchParams.get("search") || "";

  try {
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_directions (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        query TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const customMeta = db.prepare(
      "SELECT key, label, color FROM custom_directions"
    ).all() as { key: string; label: string; color: string }[];
    const directionMeta = {
      ...BUILTIN_DIRECTION_META,
      ...Object.fromEntries(customMeta.map((item) => [item.key, { label: item.label, color: item.color }])),
    };
    
    let query = "SELECT * FROM papers";
    const conditions: string[] = [];
    const params: any[] = [];
    
    if (direction !== "all") {
      conditions.push("direction = ?");
      params.push(direction);
    }
    if (search) {
      conditions.push("(title LIKE ? OR abstract LIKE ? OR authors LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY citations DESC LIMIT 100";
    
    const papers = db.prepare(query).all(...params) as any[];
    db.close();
    
    return NextResponse.json({
      papers: papers.map(p => ({
        id: p.openalex_id,
        title: p.title,
        authors: p.authors || "",
        year: p.year,
        venue: p.venue || "",
        citations: p.citations || 0,
        abstract: p.abstract || "",
        direction: p.direction,
        directionLabel: directionMeta[p.direction]?.label || p.direction,
        directionColor: directionMeta[p.direction]?.color || "#64748b",
        doi: p.doi,
        pdfUrl: p.pdf_url,
        sources: parseJson(p.sources, []),
        sourceUrls: parseJson(p.source_urls, {}),
      })),
    });
  } catch (error) {
    return NextResponse.json({ papers: [], error: String(error) }, { status: 500 });
  }
}
