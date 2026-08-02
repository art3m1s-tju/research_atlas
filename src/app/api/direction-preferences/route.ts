import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureDirectionPreferenceSchema } from "@/lib/direction-preferences";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

const BUILTIN_DIRECTIONS = [
  { key: "e2e", label: "端到端自动驾驶", color: "#3b82f6" },
  { key: "planning", label: "运动规划与控制", color: "#14b8a6" },
  { key: "world_model", label: "驾驶世界模型", color: "#b45309" },
  { key: "llm_driving", label: "大模型+驾驶", color: "#8b5cf6" },
  { key: "control", label: "车辆控制", color: "#ef4444" },
  { key: "perception", label: "BEV感知", color: "#2563eb" },
  { key: "prediction", label: "轨迹预测", color: "#e11d48" },
  { key: "rl_driving", label: "强化学习驾驶", color: "#65a30d" },
  { key: "racing", label: "自动驾驶竞赛", color: "#f43f5e" },
  { key: "safety", label: "安全验证", color: "#6b7280" },
];

function openDB() {
  const db = new Database(DB_PATH);
  ensureDirectionPreferenceSchema(db);
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_recommendation_snapshot (
      recommendation_date TEXT NOT NULL,
      filter_window TEXT NOT NULL,
      direction TEXT NOT NULL,
      paper_id INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'personal',
      score REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (recommendation_date, filter_window, direction, rank)
    )
  `);
  return db;
}

export async function GET() {
  const db = openDB();
  try {
    const custom = db.prepare("SELECT key, label, color FROM custom_directions ORDER BY created_at").all() as {
      key: string;
      label: string;
      color: string;
    }[];
    const directions = [...BUILTIN_DIRECTIONS, ...custom];
    const preferences = db.prepare(
      "SELECT direction, weight, is_active FROM direction_preferences"
    ).all() as { direction: string; weight: number; is_active: number }[];
    const preferenceMap = new Map(preferences.map((preference) => [preference.direction, preference]));

    return NextResponse.json({
      directions: directions.map((direction) => ({
        ...direction,
        weight: preferenceMap.get(direction.key)?.weight || 1,
        isActive: Boolean(preferenceMap.get(direction.key)?.is_active),
        explicitlyConfigured: preferenceMap.has(direction.key),
      })),
    });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const direction = typeof body.direction === "string" ? body.direction.trim() : "";
  const isActive = body.isActive !== false;
  const rawWeight = Number(body.weight);
  const weight = Number.isFinite(rawWeight) ? Math.min(Math.max(rawWeight, 0.5), 2) : 1;

  if (!direction) return NextResponse.json({ error: "缺少研究方向" }, { status: 400 });

  const db = openDB();
  try {
    const exists = db.prepare(`
      SELECT 1 FROM (
        SELECT key FROM custom_directions
        UNION ALL SELECT 'e2e' UNION ALL SELECT 'planning' UNION ALL SELECT 'world_model'
        UNION ALL SELECT 'llm_driving' UNION ALL SELECT 'control' UNION ALL SELECT 'perception'
        UNION ALL SELECT 'prediction' UNION ALL SELECT 'rl_driving' UNION ALL SELECT 'racing'
        UNION ALL SELECT 'safety'
      ) WHERE key = ?
    `).get(direction);
    if (!exists) return NextResponse.json({ error: "研究方向不存在" }, { status: 404 });

    db.prepare(`
      INSERT INTO direction_preferences (direction, weight, is_active, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(direction) DO UPDATE SET
        weight = excluded.weight,
        is_active = excluded.is_active,
        updated_at = CURRENT_TIMESTAMP
    `).run(direction, weight, isActive ? 1 : 0);
    db.exec("DELETE FROM daily_recommendation_snapshot WHERE recommendation_date = date('now')");

    return NextResponse.json({ direction, weight, isActive });
  } finally {
    db.close();
  }
}
