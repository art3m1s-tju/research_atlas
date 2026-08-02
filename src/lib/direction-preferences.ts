import Database from "better-sqlite3";

export function ensureDirectionPreferenceSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direction_preferences (
      direction TEXT PRIMARY KEY,
      weight REAL NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
