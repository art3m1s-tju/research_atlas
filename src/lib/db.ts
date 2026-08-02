/**
 * SQLite 数据库初始化与 Schema 管理
 *
 * 使用 better-sqlite3 同步 API，在 Next.js Server Components 中直接查询。
 * 数据库文件: data/atlas.db
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");

let _db: Database.Database | null = null;

/**
 * 获取数据库连接（单例模式）
 */
export function getDB(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);

  // 启用 WAL 模式，提升并发读性能
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // 初始化 schema
  initSchema(_db);

  return _db;
}

/**
 * 初始化数据库表结构
 */
function initSchema(db: Database.Database): void {
  db.exec(`
    -- 研究方向表
    CREATE TABLE IF NOT EXISTS directions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6b7280',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- 论文表
    CREATE TABLE IF NOT EXISTS papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      authors TEXT NOT NULL,
      author_display TEXT NOT NULL,
      author_count INTEGER NOT NULL DEFAULT 0,
      year INTEGER,
      venue TEXT,
      venue_type TEXT,
      ccf_rank TEXT,
      publication_channel TEXT,
      report_summary TEXT,
      model_tags TEXT NOT NULL DEFAULT '[]',
      citations INTEGER,
      citations_updated_at TEXT,
      is_frontier INTEGER NOT NULL DEFAULT 0,
      is_current INTEGER NOT NULL DEFAULT 0,
      abstract TEXT,
      arxiv_id TEXT,
      semantic_scholar_id TEXT,
      pdf_url TEXT,
      web_reader_url TEXT,
      evidence_url TEXT,
      obsidian_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 论文-方向关联表
    CREATE TABLE IF NOT EXISTS paper_directions (
      paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      direction_id INTEGER NOT NULL REFERENCES directions(id) ON DELETE CASCADE,
      PRIMARY KEY (paper_id, direction_id)
    );

    -- 用户偏好表
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction_id INTEGER NOT NULL REFERENCES directions(id) ON DELETE CASCADE,
      weight REAL NOT NULL DEFAULT 1.0,
      subscribed INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(direction_id)
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year DESC);
    CREATE INDEX IF NOT EXISTS idx_papers_citations ON papers(citations DESC);
    CREATE INDEX IF NOT EXISTS idx_papers_slug ON papers(slug);
    CREATE INDEX IF NOT EXISTS idx_pd_paper ON paper_directions(paper_id);
    CREATE INDEX IF NOT EXISTS idx_pd_direction ON paper_directions(direction_id);
    CREATE INDEX IF NOT EXISTS idx_prefs_direction ON user_preferences(direction_id);
  `);

  // 创建方向计数视图
  db.exec(`
    DROP VIEW IF EXISTS direction_counts;
    CREATE VIEW direction_counts AS
    SELECT
      d.id, d.key, d.label, d.color, d.sort_order,
      COUNT(pd.paper_id) as paper_count
    FROM directions d
    LEFT JOIN paper_directions pd ON d.id = pd.direction_id
    GROUP BY d.id
    ORDER BY d.sort_order;
  `);
}

// ============ 查询辅助函数 ============

/**
 * 查询所有研究方向（含论文计数）
 */
export function getDirections() {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM direction_counts
  `).all();
}

/**
 * 按方向 key 查询论文列表
 */
export function getPapersByDirection(
  directionKey: string = "all",
  options: {
    search?: string;
    page?: number;
    pageSize?: number;
    sortBy?: "citations" | "year" | "relevance";
  } = {}
) {
  const db = getDB();
  const { search, page = 1, pageSize = 20, sortBy = "citations" } = options;

  let whereClauses: string[] = [];
  let params: Record<string, unknown> = {};

  // 方向筛选
  if (directionKey !== "all") {
    whereClauses.push(`
      p.id IN (
        SELECT pd.paper_id FROM paper_directions pd
        JOIN directions d ON pd.direction_id = d.id
        WHERE d.key = @directionKey
      )
    `);
    params.directionKey = directionKey;
  }

  // 搜索
  if (search) {
    whereClauses.push(`
      (p.title LIKE @search OR p.author_display LIKE @search OR p.report_summary LIKE @search)
    `);
    params.search = `%${search}%`;
  }

  const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // 排序
  let orderBy = "p.citations DESC NULLS LAST";
  if (sortBy === "year") orderBy = "p.year DESC NULLS LAST";

  // 总数
  const total = (db.prepare(`
    SELECT COUNT(*) as count FROM papers p ${where}
  `).get(params) as { count: number }).count;

  // 分页查询
  const offset = (page - 1) * pageSize;
  const papers = db.prepare(`
    SELECT p.* FROM papers p ${where}
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset });

  // 附加方向信息
  const papersWithDirections = papers.map((paper: any) => {
    const directions = db.prepare(`
      SELECT d.key, d.label, d.color
      FROM directions d
      JOIN paper_directions pd ON d.id = pd.direction_id
      WHERE pd.paper_id = ?
    `).all(paper.id);

    return { ...paper, directions };
  });

  return {
    papers: papersWithDirections,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}

/**
 * 按 slug 查询单篇论文
 */
export function getPaperBySlug(slug: string) {
  const db = getDB();
  const paper = db.prepare(`
    SELECT * FROM papers WHERE slug = ?
  `).get(slug) as any;

  if (!paper) return null;

  const directions = db.prepare(`
    SELECT d.key, d.label, d.color
    FROM directions d
    JOIN paper_directions pd ON d.id = pd.direction_id
    WHERE pd.paper_id = ?
  `).all(paper.id);

  return { ...paper, directions };
}

/**
 * 获取推荐论文
 */
export function getRecommendations(limit: number = 10) {
  const db = getDB();

  // 基于用户偏好的推荐查询
  const papers = db.prepare(`
    SELECT p.*,
      SUM(COALESCE(up.weight, 0)) AS direction_score,
      CASE WHEN p.citations IS NULL THEN 0
           ELSE LOG10(p.citations + 1) END *
        CASE p.ccf_rank
          WHEN 'A' THEN 1.5 WHEN 'B' THEN 1.2 WHEN 'C' THEN 1.0
          ELSE 0.7
        END AS quality_score,
      CASE WHEN p.year IS NULL THEN 0.5
           ELSE EXP(-0.15 * (2026 - p.year)) END AS recency_score
    FROM papers p
    JOIN paper_directions pd ON p.id = pd.paper_id
    JOIN directions d ON pd.direction_id = d.id
    LEFT JOIN user_preferences up ON d.id = up.direction_id AND up.subscribed = 1
    WHERE up.direction_id IS NOT NULL
    GROUP BY p.id
    ORDER BY (direction_score * quality_score * recency_score) DESC
    LIMIT ?
  `).all(limit);

  // 如果没有用户偏好，返回高引论文
  if (papers.length === 0) {
    return db.prepare(`
      SELECT * FROM papers
      WHERE citations IS NOT NULL
      ORDER BY citations DESC
      LIMIT ?
    `).all(limit);
  }

  return papers;
}
