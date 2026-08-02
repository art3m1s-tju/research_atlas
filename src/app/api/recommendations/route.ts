import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { BUILTIN_DIRECTION_LABELS } from "@/lib/research-ranking";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function ensureSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_directions (
      paper_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      direction_label TEXT NOT NULL,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paper_id, direction)
    );
    CREATE TABLE IF NOT EXISTS paper_user_state (
      paper_id INTEGER PRIMARY KEY,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_saved INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const directionColumns = new Set(
    (db.prepare("PRAGMA table_info(paper_directions)").all() as { name: string }[]).map((column) => column.name),
  );
  if (!directionColumns.has("is_relevant")) db.exec("ALTER TABLE paper_directions ADD COLUMN is_relevant INTEGER NOT NULL DEFAULT 1");
  db.exec(`
    INSERT OR IGNORE INTO paper_directions (paper_id, direction, direction_label)
    SELECT id, direction, COALESCE(direction_label, direction)
    FROM papers
    WHERE direction IS NOT NULL AND direction != ''
  `);
  for (const [key, label] of Object.entries(BUILTIN_DIRECTION_LABELS)) {
    db.prepare("UPDATE paper_directions SET direction_label = ? WHERE direction = ? AND direction_label = direction").run(label, key);
    db.prepare("UPDATE papers SET direction_label = ? WHERE direction = ? AND direction_label = direction").run(label, key);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userDirections = (searchParams.get("directions") || "").split(",").filter(Boolean);
  const view = searchParams.get("view") || "recommended";
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 20), 1), 100);
  const db = new Database(DB_PATH);

  try {
    ensureSchema(db);
    const conditions = ["(p.is_relevant IS NULL OR p.is_relevant != 0)", "(s.is_hidden IS NULL OR s.is_hidden = 0)"];
    if (view === "frontier") conditions.push("p.is_frontier = 1");
    if (view === "classic") conditions.push("p.is_classic = 1");
    const rows = db.prepare(`
      SELECT p.*, s.is_read, s.is_saved, s.note
      FROM papers p
      LEFT JOIN paper_user_state s ON s.paper_id = p.id
      WHERE ${conditions.join(" AND ")}
    `).all() as any[];
    const links = rows.length
      ? db.prepare(`
          SELECT paper_id, direction, direction_label
          FROM paper_directions
          WHERE is_relevant != 0 AND paper_id IN (${rows.map(() => "?").join(",")})
        `).all(...rows.map((row) => row.id)) as { paper_id: number; direction: string; direction_label: string }[]
      : [];
    const linkMap = new Map<number, { key: string; label: string }[]>();
    for (const link of links) {
      const list = linkMap.get(link.paper_id) || [];
      list.push({ key: link.direction, label: link.direction_label });
      linkMap.set(link.paper_id, list);
    }

    let scored = rows.map((paper) => {
      const directions = linkMap.get(paper.id) || [{ key: paper.direction, label: paper.direction_label || paper.direction }];
      const matchedDirections = userDirections.filter((key) => directions.some((direction) => direction.key === key));
      const directionMatch = userDirections.length ? matchedDirections.length / userDirections.length : 1;
      const baseScore = Number(paper.recommendation_score || 0);
      const feedbackBonus = paper.is_saved ? 0.08 : 0;
      const readPenalty = paper.is_read ? -0.02 : 0;
      return { paper, directions, score: baseScore * (0.65 + 0.35 * directionMatch) + feedbackBonus + readPenalty, directionMatch };
    });
    if (userDirections.length && scored.some((item) => item.directionMatch > 0)) {
      scored = scored.filter((item) => item.directionMatch > 0);
    }
    scored.sort((left, right) => right.score - left.score || (right.paper.year || 0) - (left.paper.year || 0));

    return NextResponse.json({
      papers: scored.slice(0, limit).map(({ paper, directions, score }) => ({
        id: paper.openalex_id,
        title: paper.title,
        authors: paper.authors || "",
        year: paper.year,
        venue: paper.venue || "",
        citations: paper.citations || 0,
        abstract: paper.abstract || "",
        direction: paper.direction,
        directionLabel: paper.direction_label || paper.direction,
        directions,
        doi: paper.doi,
        pdfUrl: paper.pdf_url,
        sources: parseJson(paper.sources, []),
        sourceUrls: parseJson(paper.source_urls, {}),
        summaryZh: paper.summary_zh || null,
        innovationsZh: parseJson(paper.innovations_zh, []),
        publicationStatus: paper.publication_status || "unknown",
        venueTier: paper.venue_tier || 0,
        isFrontier: Boolean(paper.is_frontier),
        isClassic: Boolean(paper.is_classic),
        discoveryReason: paper.discovery_reason || "方向相关",
        recommendationScore: score,
        userState: { isRead: Boolean(paper.is_read), isSaved: Boolean(paper.is_saved), note: paper.note || "" },
      })),
      algorithm: "database recommendation_score × direction_match × explicit feedback",
      total: Math.min(scored.length, limit),
    });
  } finally {
    db.close();
  }
}
