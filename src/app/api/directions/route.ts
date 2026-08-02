import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import { spawn } from "child_process";
import { closeSync, mkdirSync, openSync } from "fs";
import path from "path";
import { readSyncStatus } from "@/lib/sync-status";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");
const OPENALEX_API = "https://api.openalex.org/works";
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY;

const BUILTIN_DIRECTIONS = [
  { key: "e2e", label: "端到端自动驾驶", color: "#3b82f6" },
  { key: "planning", label: "运动规划与控制", color: "#14b8a6" },
  { key: "world_model", label: "驾驶世界模型", color: "#b45309" },
  { key: "llm_driving", label: "大模型+驾驶", color: "#8b5cf6" },
  { key: "control", label: "车辆控制", color: "#ef4444" },
  { key: "perception", label: "BEV感知", color: "#2563eb" },
  { key: "prediction", label: "轨迹预测", color: "#e11d48" },
  { key: "rl_driving", label: "强化学习驾驶", color: "#65a30d" },
  { key: "racing", label: "自动驾驶竞赛", color: "#f43f5e" },
  { key: "safety", label: "安全验证", color: "#6b7280" },
];

function openDB() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_directions (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      query TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    ;
    CREATE TABLE IF NOT EXISTS paper_directions (
      paper_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      direction_label TEXT NOT NULL,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paper_id, direction)
    )
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
  return db;
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `custom-${Date.now()}`;
}

function extractAbstract(invertedIndex: Record<string, number[]> | null) {
  if (!invertedIndex) return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions) words.push([position, word]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(" ").slice(0, 600);
}

function pdfUrlFor(paper: any) {
  const arxivLocation = paper.locations?.find(
    (location: any) => location.pdf_url?.includes("arxiv")
  );
  return arxivLocation?.pdf_url || paper.locations?.find((location: any) => location.pdf_url)?.pdf_url || null;
}

async function fetchPapers(query: string) {
  const params = new URLSearchParams({
    search: query,
    per_page: "20",
    sort: "cited_by_count:desc",
    select: "id,title,authorships,publication_year,primary_location,cited_by_count,abstract_inverted_index,doi,locations",
  });
  if (OPENALEX_API_KEY) params.set("api_key", OPENALEX_API_KEY);
  const response = await fetch(`${OPENALEX_API}?${params}`);
  if (!response.ok) throw new Error(`OpenAlex ${response.status}`);
  const data = await response.json();
  return data.results || [];
}

function rankRelevantPapers(papers: any[], query: string) {
  const stopWords = new Set(["and", "the", "for", "with", "from", "using", "model", "models"]);
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !stopWords.has(term));

  return papers
    .map((paper) => {
      const title = String(paper.title || "").toLowerCase();
      const abstract = extractAbstract(paper.abstract_inverted_index).toLowerCase();
      const titleMatches = terms.filter((term) => title.includes(term)).length;
      const bodyMatches = terms.filter((term) => abstract.includes(term)).length;
      return {
        paper,
        score: titleMatches * 5 + bodyMatches,
      };
    })
    .filter(({ score }) => terms.length < 2 || score >= Math.max(2, Math.ceil(terms.length / 2)))
    .sort((a, b) => b.score - a.score || (b.paper.cited_by_count || 0) - (a.paper.cited_by_count || 0))
    .slice(0, 20)
    .map(({ paper }) => paper);
}

function ensurePaperColumns(db: Database.Database) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name)
  );
  const optionalColumns: Record<string, string> = {
    direction_label: "TEXT",
    publication_channel: "TEXT",
    is_relevant: "INTEGER NOT NULL DEFAULT 1",
    published_date: "TEXT",
    citation_percentile: "REAL",
    venue_type: "TEXT NOT NULL DEFAULT 'unknown'",
    venue_tier: "INTEGER NOT NULL DEFAULT 0",
    is_frontier: "INTEGER NOT NULL DEFAULT 0",
    is_classic: "INTEGER NOT NULL DEFAULT 0",
    discovery_reason: "TEXT NOT NULL DEFAULT '方向相关'",
    recommendation_score: "REAL NOT NULL DEFAULT 0",
  };
  for (const [column, type] of Object.entries(optionalColumns)) {
    if (!columns.has(column)) db.exec(`ALTER TABLE papers ADD COLUMN ${column} ${type}`);
  }
}

export async function GET() {
  const db = openDB();
  try {
    ensurePaperColumns(db);
    const counts = db.prepare(
      "SELECT pd.direction, COUNT(DISTINCT pd.paper_id) as count FROM paper_directions pd JOIN papers p ON p.id = pd.paper_id WHERE (p.is_relevant IS NULL OR p.is_relevant != 0) AND (pd.is_relevant IS NULL OR pd.is_relevant != 0) GROUP BY pd.direction"
    ).all() as { direction: string; count: number }[];
    const databaseStats = db.prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN is_relevant = 0 THEN 1 ELSE 0 END) as hidden FROM papers"
    ).get() as { total: number; hidden: number };
    const custom = db.prepare(
      "SELECT key, label, color FROM custom_directions ORDER BY created_at"
    ).all() as { key: string; label: string; color: string }[];
    const countMap = Object.fromEntries(counts.map((item) => [item.direction, item.count]));
    const total = (db.prepare(
      "SELECT COUNT(*) as count FROM papers WHERE is_relevant IS NULL OR is_relevant != 0"
    ).get() as { count: number }).count;

    return NextResponse.json({
      databaseStats: {
        total: databaseStats.total,
        hidden: databaseStats.hidden || 0,
        visible: databaseStats.total - (databaseStats.hidden || 0),
      },
      directions: [
        { key: "all", label: "全部方向", count: total, color: "#d4a017" },
        ...BUILTIN_DIRECTIONS.map((direction) => ({
          ...direction,
          count: countMap[direction.key] || 0,
          custom: false,
        })),
        ...custom.map((direction) => ({
          ...direction,
          count: countMap[direction.key] || 0,
          custom: true,
        })),
      ],
    });
  } finally {
    db.close();
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const color = typeof body.color === "string" ? body.color : "#0ea5e9";

  if (label.length < 2 || query.length < 3) {
    return NextResponse.json({ error: "方向名称至少 2 个字，检索关键词至少 3 个字" }, { status: 400 });
  }

  const db = openDB();
  try {
    const builtin = BUILTIN_DIRECTIONS.find((direction) => direction.label === label || direction.key === label);
    const existingCustom = db.prepare("SELECT 1 FROM custom_directions WHERE label = ?").get(label);
    if (builtin || existingCustom) return NextResponse.json({ error: "这个方向已经存在" }, { status: 409 });

    const keyBase = slugify(label);
    let key = keyBase;
    let suffix = 2;
    while (db.prepare("SELECT 1 FROM custom_directions WHERE key = ?").get(key)) {
      key = `${keyBase}-${suffix++}`;
    }

    db.prepare(
      "INSERT INTO custom_directions (key, label, query, color) VALUES (?, ?, ?, ?)"
    ).run(key, label, query, color);

    const currentSync = readSyncStatus();
    if (currentSync.state !== "running") {
      const logDirectory = path.join(process.cwd(), "data");
      mkdirSync(logDirectory, { recursive: true });
      const logDescriptor = openSync(path.join(logDirectory, "sync.log"), "a");
      const command = process.platform === "win32" ? "npx.cmd" : "npx";
      const child = spawn(command, ["tsx", path.join(process.cwd(), "scripts", "run-sync-pipeline.ts"), "--force"], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", logDescriptor, logDescriptor],
        env: process.env,
      });
      closeSync(logDescriptor);
      child.unref();
    }
    const papersAdded = (db.prepare("SELECT COUNT(DISTINCT paper_id) as count FROM paper_directions WHERE direction = ?").get(key) as { count: number }).count;

    return NextResponse.json({
      direction: { key, label, color, count: papersAdded, custom: true },
      papersAdded,
      message: currentSync.state === "running" ? "方向已创建，将在当前同步完成后更新" : "方向已创建，论文正在后台同步",
    }, { status: 201 });
  } finally {
    db.close();
  }
}
