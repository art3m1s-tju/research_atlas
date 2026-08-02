import Database from "better-sqlite3";

export function ensureUserStateSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_user_state (
      paper_id INTEGER PRIMARY KEY,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_saved INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS paper_user_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_user_events_paper ON paper_user_events(paper_id, created_at DESC);
  `);
}

export type UserAction = "read" | "unread" | "save" | "unsave" | "hide" | "unhide" | "note";

export function applyUserAction(db: Database.Database, paperId: number, action: UserAction, note?: string) {
  ensureUserStateSchema(db);
  const current = db.prepare("SELECT is_read, is_saved, is_hidden, note FROM paper_user_state WHERE paper_id = ?").get(paperId) as {
    is_read: number;
    is_saved: number;
    is_hidden: number;
    note: string;
  } | undefined;
  const next = {
    isRead: current?.is_read || 0,
    isSaved: current?.is_saved || 0,
    isHidden: current?.is_hidden || 0,
    note: current?.note || "",
  };
  if (action === "read") next.isRead = 1;
  if (action === "unread") next.isRead = 0;
  if (action === "save") next.isSaved = 1;
  if (action === "unsave") next.isSaved = 0;
  if (action === "hide") next.isHidden = 1;
  if (action === "unhide") next.isHidden = 0;
  if (action === "note") next.note = note || "";
  db.prepare(`
    INSERT INTO paper_user_state (paper_id, is_read, is_saved, is_hidden, note, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(paper_id) DO UPDATE SET
      is_read = excluded.is_read,
      is_saved = excluded.is_saved,
      is_hidden = excluded.is_hidden,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `).run(paperId, next.isRead, next.isSaved, next.isHidden, next.note);
  db.prepare("INSERT INTO paper_user_events (paper_id, event) VALUES (?, ?)").run(paperId, action);
  return db.prepare("SELECT * FROM paper_user_state WHERE paper_id = ?").get(paperId);
}
