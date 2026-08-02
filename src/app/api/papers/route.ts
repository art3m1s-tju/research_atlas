import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { cosineSimilarity, lexicalScore, parseEmbedding } from "@/lib/semantic-search";

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
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const direction = searchParams.get("direction") || "all";
  const search = searchParams.get("search") || "";

  try {
    const db = new Database(DB_PATH);
    ensureEmbeddingSchema(db);
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
    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    let papers = db.prepare(query).all(...params) as any[];
    let searchMode = "citations";
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
          const citation = Math.min(Math.log10((paper.citations || 0) + 1) / 4, 1);
          const score = queryEmbedding
            ? semantic * 0.7 + lexical * 0.2 + citation * 0.1
            : lexical * 0.8 + citation * 0.2;
          return { ...paper, matchScore: score };
        })
        .filter((paper) => paper.matchScore > 0)
        .sort((left, right) => right.matchScore - left.matchScore)
        .slice(0, 100);
    } else {
      papers = papers.sort((left, right) => (right.citations || 0) - (left.citations || 0)).slice(0, 100);
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
      })),
      searchMode,
    });
  } catch (error) {
    return NextResponse.json({ papers: [], error: String(error) }, { status: 500 });
  }
}
