import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = db.prepare("SELECT id FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as { id: number } | undefined;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const feedback = db.prepare(`
      SELECT direction, label, note, created_at
      FROM paper_relevance_feedback
      WHERE paper_id = ?
      ORDER BY created_at DESC
    `).all(paper.id);
    return NextResponse.json({ feedback });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const direction = typeof body.direction === "string" ? body.direction.trim() : "";
  const label = body.label;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!direction || !["relevant", "partial", "irrelevant"].includes(label)) {
    return NextResponse.json({ error: "方向或相关性标签无效" }, { status: 400 });
  }
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = db.prepare("SELECT id FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as { id: number } | undefined;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    db.prepare("INSERT INTO paper_relevance_feedback (paper_id, direction, label, note) VALUES (?, ?, ?, ?)").run(paper.id, direction, label, note);
    return NextResponse.json({ success: true, direction, label, note });
  } finally {
    db.close();
  }
}
