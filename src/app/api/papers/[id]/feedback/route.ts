import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { applyUserAction, ensureUserStateSchema, UserAction } from "@/lib/user-state";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");
const ACTIONS = new Set<UserAction>(["read", "unread", "save", "unsave", "hide", "unhide", "note"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const action = body.action as UserAction;
  if (!ACTIONS.has(action)) return NextResponse.json({ error: "不支持的操作" }, { status: 400 });

  const db = new Database(DB_PATH);
  try {
    ensureUserStateSchema(db);
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
    const paper = db.prepare("SELECT id FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as { id: number } | undefined;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const state = applyUserAction(db, paper.id, action, typeof body.note === "string" ? body.note : undefined);
    db.prepare("DELETE FROM daily_recommendation_snapshot WHERE recommendation_date = date('now') AND paper_id = ?").run(paper.id);
    return NextResponse.json({
      success: true,
      userState: {
        isRead: Boolean((state as any).is_read),
        isSaved: Boolean((state as any).is_saved),
        isHidden: Boolean((state as any).is_hidden),
        note: (state as any).note || "",
      },
    });
  } finally {
    db.close();
  }
}
