import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { cosineSimilarity, lexicalScore, parseEmbedding } from "@/lib/semantic-search";
import { metadataForPaper } from "@/lib/research-ranking";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

const BUILTIN_DIRECTION_META: Record<string, { label: string; color: string }> = {
  e2e: { label: "端到端自动驾驶", color: "#3b82f6" },
  planning: { label: "运动规划与控制", color: "#14b8a6" },
  world_model: { label: "驾驶世界模型", color: "#b45309" },
  llm_driving: { label: "大模型+驾驶", color: "#8b5cf6" },
  control: { label: "车辆控制", color: "#ef4444" },
  perception: { label: "BEV感知", color: "#2563eb" },
  prediction: { label: "轨迹预测", color: "#e11d48" },
  rl_driving: { label: "强化学习驾驶", color: "#65a30d" },
  racing: { label: "自动驾驶竞赛", color: "#f43f5e" },
  safety: { label: "安全验证", color: "#6b7280" },
};

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function ensureEmbeddingSchema(db: Database.Database) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name),
  );
  if (!columns.has("embedding")) db.exec("ALTER TABLE papers ADD COLUMN embedding TEXT");
  if (!columns.has("embedding_model")) db.exec("ALTER TABLE papers ADD COLUMN embedding_model TEXT");
  if (!columns.has("summary_zh")) db.exec("ALTER TABLE papers ADD COLUMN summary_zh TEXT");
  if (!columns.has("innovations_zh")) db.exec("ALTER TABLE papers ADD COLUMN innovations_zh TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has("method_zh")) db.exec("ALTER TABLE papers ADD COLUMN method_zh TEXT");
  if (!columns.has("results_zh")) db.exec("ALTER TABLE papers ADD COLUMN results_zh TEXT");
  if (!columns.has("limitations_zh")) db.exec("ALTER TABLE papers ADD COLUMN limitations_zh TEXT");
  if (!columns.has("summary_model")) db.exec("ALTER TABLE papers ADD COLUMN summary_model TEXT");
  if (!columns.has("summary_source_hash")) db.exec("ALTER TABLE papers ADD COLUMN summary_source_hash TEXT");
  if (!columns.has("summary_updated_at")) db.exec("ALTER TABLE papers ADD COLUMN summary_updated_at TEXT");
  if (!columns.has("is_relevant")) db.exec("ALTER TABLE papers ADD COLUMN is_relevant INTEGER NOT NULL DEFAULT 1");
  if (!columns.has("published_date")) db.exec("ALTER TABLE papers ADD COLUMN published_date TEXT");
  if (!columns.has("citation_percentile")) db.exec("ALTER TABLE papers ADD COLUMN citation_percentile REAL");
  if (!columns.has("venue_type")) db.exec("ALTER TABLE papers ADD COLUMN venue_type TEXT NOT NULL DEFAULT 'unknown'");
  if (!columns.has("venue_tier")) db.exec("ALTER TABLE papers ADD COLUMN venue_tier INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("is_frontier")) db.exec("ALTER TABLE papers ADD COLUMN is_frontier INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("is_classic")) db.exec("ALTER TABLE papers ADD COLUMN is_classic INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("discovery_reason")) db.exec("ALTER TABLE papers ADD COLUMN discovery_reason TEXT NOT NULL DEFAULT '方向相关'");
  if (!columns.has("recommendation_score")) db.exec("ALTER TABLE papers ADD COLUMN recommendation_score REAL NOT NULL DEFAULT 0");
  if (!columns.has("last_seen_at")) db.exec("ALTER TABLE papers ADD COLUMN last_seen_at TEXT");
}

function refreshRecommendationMetadata(db: Database.Database) {
  const papers = db.prepare(`
    SELECT id, title, year, published_date, venue, publication_channel, citations, citation_percentile
    FROM papers
  `).all() as Array<{
    id: number;
    title: string;
    year: number | null;
    published_date: string | null;
    venue: string | null;
    publication_channel: string | null;
    citations: number | null;
    citation_percentile: number | null;
  }>;
  const update = db.prepare(`
    UPDATE papers
    SET venue_type = ?, venue_tier = ?, is_frontier = ?, is_classic = ?,
        discovery_reason = ?, recommendation_score = ?
    WHERE id = ?
  `);
  const transaction = db.transaction(() => {
    for (const paper of papers) {
      const metadata = metadataForPaper(paper);
      update.run(
        metadata.venueType,
        metadata.venueTier,
        metadata.isFrontier ? 1 : 0,
        metadata.isClassic ? 1 : 0,
        metadata.discoveryReason,
        metadata.recommendationScore,
        paper.id,
      );
    }
  });
  transaction();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const direction = searchParams.get("direction") || "all";
  const search = searchParams.get("search") || "";
  const view = searchParams.get("view") || "recommended";

  try {
    const db = new Database(DB_PATH);
    ensureEmbeddingSchema(db);
    refreshRecommendationMetadata(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_directions (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        query TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const customMeta = db.prepare(
      "SELECT key, label, color FROM custom_directions"
    ).all() as { key: string; label: string; color: string }[];
    const directionMeta = {
      ...BUILTIN_DIRECTION_META,
      ...Object.fromEntries(customMeta.map((item) => [item.key, { label: item.label, color: item.color }])),
    };
    
    let query = "SELECT * FROM papers";
    const conditions: string[] = [];
    const params: any[] = [];
    
    if (direction !== "all") {
      conditions.push("direction = ?");
      params.push(direction);
    }
    conditions.push("(is_relevant IS NULL OR is_relevant != 0)");
    if (view === "frontier") conditions.push("is_frontier = 1");
    if (view === "classic") conditions.push("is_classic = 1");
    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    let papers = db.prepare(query).all(...params) as any[];
    let searchMode = "recommended";
    if (search.trim()) {
      let queryEmbedding: number[] | null = null;
      try {
        const { embedText } = await import("@/lib/semantic-search");
        queryEmbedding = await embedText(search.trim());
        searchMode = "hybrid";
      } catch (error) {
        console.warn("Semantic search unavailable; falling back to keyword ranking", error);
        searchMode = "keyword-fallback";
      }

      papers = papers
        .map((paper) => {
          const text = [paper.title, paper.abstract, paper.authors, paper.venue]
            .filter(Boolean)
            .join(" ");
          const semantic = queryEmbedding && parseEmbedding(paper.embedding)
            ? Math.max(0, cosineSimilarity(queryEmbedding, parseEmbedding(paper.embedding) || []))
            : 0;
          const lexical = lexicalScore(text, search);
          const recommendation = Math.min(Math.max(Number(paper.recommendation_score || 0), 0), 1);
          const score = queryEmbedding
            ? semantic * 0.6 + lexical * 0.25 + recommendation * 0.15
            : lexical * 0.8 + recommendation * 0.2;
          return { ...paper, matchScore: score };
        })
        .filter((paper) => paper.matchScore > 0)
        .sort((left, right) => right.matchScore - left.matchScore)
        .slice(0, 100);
    } else {
      papers = papers
        .sort((left, right) =>
          (right.recommendation_score || 0) - (left.recommendation_score || 0)
          || (right.is_frontier || 0) - (left.is_frontier || 0)
          || (right.year || 0) - (left.year || 0)
          || (right.citations || 0) - (left.citations || 0)
        )
        .slice(0, 100);
    }

    db.close();
    
    return NextResponse.json({
      papers: papers.map(p => ({
        id: p.openalex_id,
        title: p.title,
        authors: p.authors || "",
        year: p.year,
        venue: p.venue || "",
        citations: p.citations || 0,
        citationPercentile: p.citation_percentile || null,
        abstract: p.abstract || "",
        direction: p.direction,
        directionLabel: directionMeta[p.direction]?.label || p.direction,
        directionColor: directionMeta[p.direction]?.color || "#64748b",
        doi: p.doi,
        pdfUrl: p.pdf_url,
        sources: parseJson(p.sources, []),
        sourceUrls: parseJson(p.source_urls, {}),
        matchScore: p.matchScore,
        summaryZh: p.summary_zh || null,
        innovationsZh: parseJson(p.innovations_zh, []),
        methodZh: p.method_zh || null,
        resultsZh: p.results_zh || null,
        limitationsZh: p.limitations_zh || null,
        publicationChannel: p.publication_channel || (p.venue === "arXiv" ? "arXiv 预印本" : "同行评议渠道待核实"),
        venueType: p.venue_type || "unknown",
        venueTier: p.venue_tier || 0,
        isFrontier: Boolean(p.is_frontier),
        isClassic: Boolean(p.is_classic),
        discoveryReason: p.discovery_reason || "方向相关",
        recommendationScore: p.recommendation_score || 0,
      })),
      searchMode,
    });
  } catch (error) {
    return NextResponse.json({ papers: [], error: String(error) }, { status: 500 });
  }
}
