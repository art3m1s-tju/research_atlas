import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";
import { buildClassificationPrompt, classificationSourceHash, defaultDirections, heuristicClassification, normalizeClassification, parseClassificationJson, type ClassificationDirection, type PaperClassification } from "@/lib/paper-classification";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");
const MODEL = process.env.DEEPSEEK_CLASSIFIER_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const API_BASE_URL = process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com";

function ensureDirectionSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_directions (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      query TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#0ea5e9',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS paper_directions (
      paper_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      direction_label TEXT NOT NULL,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paper_id, direction)
    );
  `);
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || `custom-${Date.now()}`;
}

async function classifyWithDeepSeek(paper: any, directions: ClassificationDirection[]) {
  const prompt = buildClassificationPrompt(paper, directions);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DEEPSEEK_CLASSIFIER_TIMEOUT_MS || 30000));
  try {
    const response = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        thinking: { type: "disabled" },
        temperature: 0.1,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${(await response.text()).slice(0, 240)}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek 返回空分类结果");
    return normalizeClassification(parseClassificationJson(content), directions);
  } finally {
    clearTimeout(timeout);
  }
}

function applyDirections(db: Database.Database, paperId: number, classification: PaperClassification, directions: ClassificationDirection[]) {
  const byKey = new Map(directions.map((direction) => [direction.key, direction]));
  const keys = [classification.primary_direction, ...classification.secondary_directions].filter((key): key is string => Boolean(key));
  const insert = db.prepare("INSERT OR IGNORE INTO paper_directions (paper_id, direction, direction_label, is_relevant) VALUES (?, ?, ?, 1)");
  for (const key of [...new Set(keys)]) insert.run(paperId, key, byKey.get(key)?.label || key);
  const primary = classification.primary_direction ? byKey.get(classification.primary_direction) : null;
  if (primary) db.prepare("UPDATE papers SET direction = ?, direction_label = ? WHERE id = ? AND (direction IS NULL OR direction = '')").run(primary.key, primary.label, paperId);
  return keys.map((key) => byKey.get(key)?.label || key);
}

function createSuggestedDirection(db: Database.Database, paperId: number, suggestion: NonNullable<PaperClassification["new_direction"]>) {
  const existing = db.prepare("SELECT key, label, query FROM custom_directions WHERE label = ? OR query = ? LIMIT 1").get(suggestion.label, suggestion.query) as { key: string; label: string; query: string } | undefined;
  if (existing) {
    db.prepare("INSERT OR IGNORE INTO paper_directions (paper_id, direction, direction_label, is_relevant) VALUES (?, ?, ?, 1)").run(paperId, existing.key, existing.label);
    return existing;
  }
  const base = slugify(suggestion.label);
  let key = base;
  let suffix = 2;
  while (db.prepare("SELECT 1 FROM custom_directions WHERE key = ?").get(key)) key = `${base}-${suffix++}`;
  db.prepare("INSERT INTO custom_directions (key, label, query, color) VALUES (?, ?, ?, ?)").run(key, suggestion.label, suggestion.query, "#0ea5e9");
  db.prepare("INSERT OR IGNORE INTO paper_directions (paper_id, direction, direction_label, is_relevant) VALUES (?, ?, ?, 1)").run(paperId, key, suggestion.label);
  return { key, label: suggestion.label, query: suggestion.query };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const paperId = Number(body.paperDbId);
  if (!Number.isInteger(paperId) || paperId <= 0) return NextResponse.json({ error: "缺少有效的论文 ID" }, { status: 400 });
  const apply = body.apply !== false;
  const createDirection = body.createDirection === true;
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    ensureDirectionSchema(db);
    const paper = db.prepare("SELECT id, title, abstract, authors, year, venue FROM papers WHERE id = ?").get(paperId) as any;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const custom = db.prepare("SELECT key, label, query FROM custom_directions ORDER BY created_at").all() as ClassificationDirection[];
    const directions = defaultDirections(custom);
    const sourceHash = classificationSourceHash(paper);
    const cached = db.prepare("SELECT result_json, model, source_hash FROM paper_classifications WHERE paper_id = ?").get(paperId) as { result_json: string; model: string; source_hash: string } | undefined;
    let classification: PaperClassification;
    let provider: "deepseek" | "heuristic" = "deepseek";
    let wasCached = false;
    if (cached?.source_hash === sourceHash) {
      classification = JSON.parse(cached.result_json) as PaperClassification;
      wasCached = true;
    } else if (process.env.DEEPSEEK_API_KEY) {
      classification = await classifyWithDeepSeek(paper, directions);
      db.prepare("INSERT INTO paper_classifications (paper_id, result_json, model, source_hash) VALUES (?, ?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET result_json = excluded.result_json, model = excluded.model, source_hash = excluded.source_hash, created_at = CURRENT_TIMESTAMP").run(paperId, JSON.stringify(classification), MODEL, sourceHash);
    } else {
      classification = heuristicClassification(paper, directions);
      provider = "heuristic";
    }
    const appliedDirections = apply && classification.primary_direction ? applyDirections(db, paperId, classification, directions) : [];
    const created = createDirection && classification.new_direction ? createSuggestedDirection(db, paperId, classification.new_direction) : null;
    const directionLabels = Object.fromEntries(directions.map((direction) => [direction.key, direction.label]));
    return NextResponse.json({ success: true, classification: { ...classification, primary_label: classification.primary_direction ? directionLabels[classification.primary_direction] : null, secondary_labels: classification.secondary_directions.map((key) => directionLabels[key] || key) }, appliedDirections, createdDirection: created, provider, cached: wasCached, model: provider === "deepseek" ? MODEL : null, message: provider === "heuristic" ? "未配置智能分类模型，已使用本地规则；配置后重新分类可获得更准确结果。" : wasCached ? "使用已缓存的分类结果，未重复消耗模型额度。" : "已完成智能分类。" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  } finally {
    db.close();
  }
}
