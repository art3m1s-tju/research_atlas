import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

export async function GET() {
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const clusters = db.prepare("SELECT id, name, color, created_at, updated_at FROM interest_clusters ORDER BY updated_at DESC").all() as any[];
    const directions = db.prepare("SELECT cluster_id, direction, weight FROM interest_cluster_directions").all() as any[];
    return NextResponse.json({
      clusters: clusters.map((cluster) => ({
        ...cluster,
        directions: directions.filter((direction) => direction.cluster_id === cluster.id),
      })),
    });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const color = typeof body.color === "string" ? body.color : "#3b82f6";
  const directionList = Array.isArray(body.directions) ? body.directions : [];
  if (name.length < 2) return NextResponse.json({ error: "兴趣簇名称至少 2 个字" }, { status: 400 });

  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const result = db.prepare("INSERT INTO interest_clusters (name, color) VALUES (?, ?)").run(name, color);
    const clusterId = Number(result.lastInsertRowid);
    const insertDirection = db.prepare("INSERT OR REPLACE INTO interest_cluster_directions (cluster_id, direction, weight) VALUES (?, ?, ?)");
    for (const item of directionList) {
      if (typeof item === "string") insertDirection.run(clusterId, item, 1);
      else if (item && typeof item.direction === "string") insertDirection.run(clusterId, item.direction, Number(item.weight) || 1);
    }
    return NextResponse.json({ success: true, id: clusterId }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  } finally {
    db.close();
  }
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const color = typeof body.color === "string" ? body.color : "#3b82f6";
  const directionList = Array.isArray(body.directions) ? body.directions : [];
  if (!Number.isInteger(id) || name.length < 2) return NextResponse.json({ error: "兴趣簇参数无效" }, { status: 400 });
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const transaction = db.transaction(() => {
      db.prepare("UPDATE interest_clusters SET name = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(name, color, id);
      db.prepare("DELETE FROM interest_cluster_directions WHERE cluster_id = ?").run(id);
      const insertDirection = db.prepare("INSERT INTO interest_cluster_directions (cluster_id, direction, weight) VALUES (?, ?, ?)");
      for (const item of directionList) {
        if (typeof item === "string") insertDirection.run(id, item, 1);
        else if (item && typeof item.direction === "string") insertDirection.run(id, item.direction, Number(item.weight) || 1);
      }
    });
    transaction();
    return NextResponse.json({ success: true, id });
  } finally {
    db.close();
  }
}

export async function DELETE(request: NextRequest) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return NextResponse.json({ error: "缺少兴趣簇 id" }, { status: 400 });
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    db.prepare("DELETE FROM interest_cluster_directions WHERE cluster_id = ?").run(id);
    db.prepare("DELETE FROM interest_clusters WHERE id = ?").run(id);
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}
