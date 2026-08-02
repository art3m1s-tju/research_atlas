import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { BUILTIN_DIRECTION_LABELS } from "@/lib/research-ranking";
import { ensureDirectionPreferenceSchema } from "@/lib/direction-preferences";
import { ensureUserStateSchema } from "@/lib/user-state";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

const RELATED_DIRECTIONS: Record<string, string[]> = {
  e2e: ["planning", "world_model", "perception", "prediction", "safety"],
  planning: ["control", "prediction", "e2e", "racing", "world_model"],
  world_model: ["e2e", "rl_driving", "llm_driving", "prediction"],
  llm_driving: ["world_model", "e2e", "rl_driving", "safety"],
  control: ["planning", "racing", "safety", "e2e"],
  perception: ["e2e", "prediction", "world_model", "safety"],
  prediction: ["planning", "perception", "e2e", "world_model"],
  rl_driving: ["world_model", "planning", "e2e"],
  racing: ["planning", "control", "e2e"],
  safety: ["control", "e2e", "perception", "llm_driving"],
};

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function ensureSchema(db: Database.Database) {
  ensureUserStateSchema(db);
  ensureDirectionPreferenceSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_directions (
      paper_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      direction_label TEXT NOT NULL,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paper_id, direction)
    );
    CREATE TABLE IF NOT EXISTS daily_recommendation_history (
      paper_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      shown_on TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paper_id, direction, shown_on)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_recommendation_history_date
      ON daily_recommendation_history(shown_on);
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

function recommendationReason(paper: any, prefix = "") {
  const parts: string[] = [];
  if (paper.is_frontier) parts.push("近期前沿");
  if ((paper.venue_tier || 0) >= 3) parts.push("顶会/顶刊");
  if (paper.is_classic) parts.push("经典必读");
  if (!parts.length) parts.push("方向精选");
  return [prefix, parts.join(" · ")].filter(Boolean).join(" · ");
}

function mapPaper(paper: any, direction: { key: string; label: string }, score: number, reasonPrefix = "") {
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
    discoveryReason: recommendationReason(paper, reasonPrefix),
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

    const configuredRows = db.prepare(`
      SELECT direction, weight, is_active
      FROM direction_preferences
      ORDER BY weight DESC, updated_at DESC
    `).all() as { direction: string; weight: number; is_active: number }[];
    const configuredMap = new Map(configuredRows.map((row) => [row.direction, row]));
    const activeConfiguredRows = configuredRows.filter((row) => row.is_active !== 0);
    const disabledDirections = new Set(configuredRows.filter((row) => row.is_active === 0).map((row) => row.direction));

    const behaviorRows = db.prepare(`
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

    const behaviorMap = new Map(behaviorRows.map((row) => [row.direction, row]));
    const directionKeys = requestedDirections.length
      ? requestedDirections
      : activeConfiguredRows.length
        ? activeConfiguredRows.slice(0, 8).map((row) => row.direction)
        : behaviorRows.filter((row) => !disabledDirections.has(row.direction)).slice(0, 8).map((row) => row.direction);
    const directionWeights = new Map(directionKeys.map((key) => [
      key,
      configuredMap.get(key)?.weight || (behaviorMap.get(key) ? Math.min(2, 1 + behaviorMap.get(key)!.preference_score / 10) : 1),
    ]));
    const hasPreferenceData = activeConfiguredRows.length > 0 || behaviorRows.some((row) => !disabledDirections.has(row.direction));

    if (!directionKeys.length) {
      return NextResponse.json({
        hasPreferenceData,
        generatedAt: new Date().toISOString(),
        message: configuredRows.length > 0
          ? "目前没有启用的研究方向，请在左侧“管理每日推荐方向”中打开至少一个方向。"
          : "还没有足够的兴趣数据。先收藏或标记几篇论文，每个方向就会自动生成每日精选。",
        directions: [],
        total: 0,
      });
    }

    const selectedIds = new Set<number>();
    const getDirectionRow = (directionKey: string) => db.prepare(`
      SELECT direction, direction_label
      FROM paper_directions
      WHERE direction = ?
      LIMIT 1
    `).get(directionKey) as { direction: string; direction_label: string } | undefined;

    const scoreCandidates = (directionKey: string) => {
      const candidates = db.prepare(`
        SELECT p.*, pd.direction_label, s.is_read, s.is_saved, s.is_hidden, s.note,
          EXISTS(
            SELECT 1 FROM daily_recommendation_history h
            WHERE h.paper_id = p.id
              AND h.shown_on >= date('now', '-3 day')
              AND h.shown_on < date('now')
          ) AS recently_shown
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
        const readAdjustment = paper.is_read ? -0.1 : 0.08;
        const historyAdjustment = paper.recently_shown ? -0.25 : 0;
        const directionWeight = directionWeights.get(directionKey) || 1;
        const score = (base * 0.32 + recency * 0.28 + venue * 0.2 + impact * 0.1 + readAdjustment + historyAdjustment)
          * (0.85 + directionWeight * 0.15);
        return { paper, score };
      }).sort((left, right) => right.score - left.score || (right.paper.year || 0) - (left.paper.year || 0));

      const fresh = scored.filter(({ paper }) => !paper.recently_shown);
      return fresh.length >= perDirection ? fresh : scored;
    };

    const choosePapers = (directionKey: string, limit: number, reasonPrefix = "") => {
      const directionRow = getDirectionRow(directionKey);
      if (!directionRow) return null;
      const chosen: { paper: any; score: number }[] = [];
      for (const candidate of scoreCandidates(directionKey)) {
        if (selectedIds.has(candidate.paper.id)) continue;
        chosen.push(candidate);
        selectedIds.add(candidate.paper.id);
        if (chosen.length >= limit) break;
      }
      if (!chosen.length) return null;
      const label = directionRow.direction_label || BUILTIN_DIRECTION_LABELS[directionRow.direction] || directionRow.direction;
      const insertHistory = db.prepare(`
        INSERT OR IGNORE INTO daily_recommendation_history (paper_id, direction, shown_on)
        VALUES (?, ?, date('now'))
      `);
      for (const { paper } of chosen) insertHistory.run(paper.id, directionRow.direction);
      return {
        key: directionRow.direction,
        label,
        papers: chosen.map(({ paper, score }) => mapPaper(paper, { key: directionRow.direction, label }, score, reasonPrefix)),
      };
    };

    const sections = [];
    for (const directionKey of directionKeys) {
      const section = choosePapers(directionKey, perDirection);
      if (section) sections.push({ ...section, kind: "personal" });
    }

    const personalCount = sections.reduce((sum, section) => sum + section.papers.length, 0);
    const explorationLimit = Math.min(2, Math.max(1, Math.round(personalCount * 0.2)));
    const explorationKeys = [...new Set(directionKeys.flatMap((key) => RELATED_DIRECTIONS[key] || []))]
      .filter((key) => !directionKeys.includes(key) && !disabledDirections.has(key));
    const explorationPapers: any[] = [];
    for (const directionKey of explorationKeys) {
      const section = choosePapers(directionKey, explorationLimit, "相邻方向探索");
      if (!section) continue;
      explorationPapers.push(...section.papers);
      if (explorationPapers.length >= explorationLimit) break;
    }
    if (explorationPapers.length) {
      sections.push({
        key: "exploration",
        label: "探索邻域",
        kind: "exploration",
        papers: explorationPapers.slice(0, explorationLimit),
      });
    }

    return NextResponse.json({
      hasPreferenceData,
      generatedAt: new Date().toISOString(),
      message: sections.length ? "根据你的研究方向和阅读行为生成；其中少量内容来自相邻方向探索" : "你关注的方向暂时没有可推荐论文",
      directions: sections,
      total: sections.reduce((sum, section) => sum + section.papers.length, 0),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error), directions: [], total: 0 }, { status: 500 });
  } finally {
    db.close();
  }
}
