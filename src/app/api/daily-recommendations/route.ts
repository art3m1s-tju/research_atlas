import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { BUILTIN_DIRECTION_LABELS } from "@/lib/research-ranking";
import { ensureUserStateSchema } from "@/lib/user-state";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function ensureSchema(db: Database.Database) {
  ensureUserStateSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_directions (
      paper_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      direction_label TEXT NOT NULL,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paper_id, direction)
    )
  `);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(paper_directions)").all() as { name: string }[]).map((column) => column.name),
  );
  if (!columns.has("is_relevant")) db.exec("ALTER TABLE paper_directions ADD COLUMN is_relevant INTEGER NOT NULL DEFAULT 1");
  db.exec(`
    INSERT OR IGNORE INTO paper_directions (paper_id, direction, direction_label)
    SELECT id, direction, COALESCE(direction_label, direction)
    FROM papers
    WHERE direction IS NOT NULL AND direction != ''
  `);
  for (const [key, label] of Object.entries(BUILTIN_DIRECTION_LABELS)) {
    db.prepare("UPDATE paper_directions SET direction_label = ? WHERE direction = ? AND direction_label = direction").run(label, key);
  }
}

function impactScore(citations: number | null, percentile: number | null) {
  if (typeof percentile === "number") {
    const normalized = percentile > 1 ? percentile / 100 : percentile;
    return Math.max(0, Math.min(normalized, 1));
  }
  return Math.min(Math.log10((citations || 0) + 1) / 4, 1);
}

function recencyScore(year: number | null, publishedDate: string | null) {
  const published = publishedDate ? new Date(publishedDate) : null;
  const date = published && !Number.isNaN(published.getTime()) ? published : year ? new Date(`${year}-12-31`) : null;
  if (!date) return 0;
  const ageMonths = Math.max(0, (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 30.4));
  return Math.exp(-ageMonths / 30);
}

function recommendationReason(paper: any) {
  const parts: string[] = [];
  if (paper.is_frontier) parts.push("近期前沿");
  if ((paper.venue_tier || 0) >= 3) parts.push("顶会/顶刊");
  if (paper.is_classic) parts.push("经典必读");
  if (!parts.length) parts.push("方向精选");
  return parts.join(" · ");
}

function mapPaper(paper: any, direction: { key: string; label: string }, score: number) {
  return {
    id: paper.openalex_id,
    title: paper.title,
    authors: paper.authors || "",
    year: paper.year,
    venue: paper.venue || "",
    citations: paper.citations || 0,
    citationPercentile: paper.citation_percentile || null,
    abstract: paper.abstract || "",
    direction: direction.key,
    directionLabel: direction.label,
    directions: [{ key: direction.key, label: direction.label }],
    doi: paper.doi,
    pdfUrl: paper.pdf_url,
    sources: parseJson(paper.sources, []),
    sourceUrls: parseJson(paper.source_urls, {}),
    summaryZh: paper.summary_zh || null,
    innovationsZh: parseJson(paper.innovations_zh, []),
    methodZh: paper.method_zh || null,
    resultsZh: paper.results_zh || null,
    limitationsZh: paper.limitations_zh || null,
    publicationChannel: paper.publication_channel || null,
    publicationStatus: paper.publication_status || "unknown",
    venueVerified: Boolean(paper.venue_verified),
    venueConfidence: paper.venue_confidence || 0,
    qualityScore: paper.quality_score || 0,
    venueType: paper.venue_type || "unknown",
    venueTier: paper.venue_tier || 0,
    isFrontier: Boolean(paper.is_frontier),
    isClassic: Boolean(paper.is_classic),
    discoveryReason: recommendationReason(paper),
    recommendationScore: score,
    userState: {
      isRead: Boolean(paper.is_read),
      isSaved: Boolean(paper.is_saved),
      isHidden: Boolean(paper.is_hidden),
      note: paper.note || "",
    },
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get("limit") || 2);
  const perDirection = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 2, 1), 2);
  const requestedDirections = (searchParams.get("directions") || "").split(",").map((value) => value.trim()).filter(Boolean);
  const db = new Database(DB_PATH);

  try {
    ensureSchema(db);

    const preferenceRows = db.prepare(`
      SELECT pd.direction,
        SUM(CASE
          WHEN e.event = 'save' THEN 3
          WHEN e.event = 'read' THEN 1
          WHEN e.event = 'unsave' THEN -3
          WHEN e.event = 'unread' THEN -1
          WHEN e.event = 'hide' THEN -4
          WHEN e.event = 'unhide' THEN 4
          ELSE 0
        END) AS preference_score,
        COUNT(DISTINCT e.paper_id) AS papers_interacted
      FROM paper_user_events e
      JOIN paper_directions pd ON pd.paper_id = e.paper_id AND pd.is_relevant != 0
      GROUP BY pd.direction
      HAVING preference_score > 0
      ORDER BY preference_score DESC, papers_interacted DESC
    `).all() as { direction: string; preference_score: number; papers_interacted: number }[];

    const preferenceMap = new Map(preferenceRows.map((row) => [row.direction, row]));
    const directionKeys = requestedDirections.length
      ? requestedDirections
      : preferenceRows.slice(0, 8).map((row) => row.direction);

    if (!directionKeys.length) {
      return NextResponse.json({
        hasPreferenceData: false,
        generatedAt: new Date().toISOString(),
        message: "还没有足够的兴趣数据。先收藏或标记几篇论文，每个方向就会自动生成每日精选。",
        directions: [],
        total: 0,
      });
    }

    const selectedIds = new Set<number>();
    const sections = [];
    for (const directionKey of directionKeys) {
      const directionRow = db.prepare(`
        SELECT direction, direction_label
        FROM paper_directions
        WHERE direction = ?
        LIMIT 1
      `).get(directionKey) as { direction: string; direction_label: string } | undefined;
      if (!directionRow) continue;

      const candidates = db.prepare(`
        SELECT p.*, pd.direction_label, s.is_read, s.is_saved, s.is_hidden, s.note
        FROM papers p
        JOIN paper_directions pd ON pd.paper_id = p.id AND pd.direction = ? AND pd.is_relevant != 0
        LEFT JOIN paper_user_state s ON s.paper_id = p.id
        WHERE (p.is_relevant IS NULL OR p.is_relevant != 0)
          AND (s.is_hidden IS NULL OR s.is_hidden = 0)
        ORDER BY p.is_frontier DESC, p.venue_tier DESC, p.year DESC, p.citations DESC
      `).all(directionKey) as any[];

      const scored = candidates.map((paper) => {
        const base = Number(paper.recommendation_score || 0);
        const recency = recencyScore(paper.year, paper.published_date);
        const venue = Math.min(Math.max(Number(paper.venue_tier || 0), 0) / 3, 1);
        const impact = impactScore(paper.citations, paper.citation_percentile);
        const unread = paper.is_read ? 0 : 1;
        const score = base * 0.35 + recency * 0.3 + venue * 0.2 + impact * 0.1 + unread * 0.05;
        return { paper, score };
      }).sort((left, right) => right.score - left.score || (right.paper.year || 0) - (left.paper.year || 0));

      const chosen: { paper: any; score: number }[] = [];
      for (const candidate of scored) {
        if (selectedIds.has(candidate.paper.id)) continue;
        chosen.push(candidate);
        selectedIds.add(candidate.paper.id);
        if (chosen.length >= perDirection) break;
      }
      if (!chosen.length) continue;

      sections.push({
        key: directionRow.direction,
        label: directionRow.direction_label || BUILTIN_DIRECTION_LABELS[directionRow.direction] || directionRow.direction,
        preferenceScore: preferenceMap.get(directionKey)?.preference_score || 0,
        papers: chosen.map(({ paper, score }) => mapPaper(paper, {
          key: directionRow.direction,
          label: directionRow.direction_label || BUILTIN_DIRECTION_LABELS[directionRow.direction] || directionRow.direction,
        }, score)),
      });
    }

    return NextResponse.json({
      hasPreferenceData: preferenceRows.length > 0,
      generatedAt: new Date().toISOString(),
      message: sections.length ? "根据你的阅读与收藏行为生成" : "你关注的方向暂时没有可推荐论文",
      directions: sections,
      total: sections.reduce((sum, section) => sum + section.papers.length, 0),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error), directions: [], total: 0 }, { status: 500 });
  } finally {
    db.close();
  }
}
