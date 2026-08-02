import Database from "better-sqlite3";

export function ensureResearchFeatureSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_items (
      paper_id INTEGER PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'BibTeX',
      external_key TEXT,
      collection TEXT,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS interest_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS interest_cluster_directions (
      cluster_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (cluster_id, direction)
    );
    CREATE TABLE IF NOT EXISTS paper_relevance_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      label TEXT NOT NULL CHECK(label IN ('relevant', 'partial', 'irrelevant')),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_paper_relevance_feedback_direction
      ON paper_relevance_feedback(direction, created_at DESC);
    CREATE TABLE IF NOT EXISTS paper_exclusion_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL DEFAULT 'all',
      term TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'exclude' CHECK(mode IN ('exclude', 'require')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(direction, term, mode)
    );
    CREATE TABLE IF NOT EXISTS paper_relations (
      paper_id INTEGER NOT NULL,
      related_paper_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'local',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paper_id, related_paper_id, relation)
    );
    CREATE TABLE IF NOT EXISTS paper_evidence (
      paper_id INTEGER PRIMARY KEY,
      evidence_json TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      channel TEXT NOT NULL DEFAULT 'file',
      destination TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      source TEXT NOT NULL,
      direction TEXT NOT NULL,
      cursor TEXT,
      records_fetched INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (source, direction)
    );
  `);
}

export function paperFeatureColumns(db: Database.Database) {
  return new Set(
    (db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name),
  );
}
