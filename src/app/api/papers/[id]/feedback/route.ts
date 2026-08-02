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
    const paper = db.prepare("SELECT id FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as { id: number } | undefined;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const state = applyUserAction(db, paper.id, action, typeof body.note === "string" ? body.note : undefined);
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
