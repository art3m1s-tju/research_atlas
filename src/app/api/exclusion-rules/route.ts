import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

export async function GET() {
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    return NextResponse.json({ rules: db.prepare("SELECT id, direction, term, mode, created_at FROM paper_exclusion_rules ORDER BY created_at DESC").all() });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const direction = typeof body.direction === "string" && body.direction.trim() ? body.direction.trim() : "all";
  const term = typeof body.term === "string" ? body.term.trim().toLowerCase() : "";
  const mode = body.mode === "require" ? "require" : "exclude";
  if (term.length < 2) return NextResponse.json({ error: "规则关键词至少 2 个字符" }, { status: 400 });
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    db.prepare("INSERT OR IGNORE INTO paper_exclusion_rules (direction, term, mode) VALUES (?, ?, ?)").run(direction, term, mode);
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}

export async function DELETE(request: NextRequest) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return NextResponse.json({ error: "缺少规则 id" }, { status: 400 });
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    db.prepare("DELETE FROM paper_exclusion_rules WHERE id = ?").run(id);
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}
