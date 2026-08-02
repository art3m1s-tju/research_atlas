import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { isLikelyRelevant } from "../src/lib/relevance";
import {
  CLASSIC_SEEDS,
  metadataForPaper,
  normalizeTitle,
} from "../src/lib/research-ranking";

function loadLocalEnv() {
  const envPath = ".env.local";
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const DB_PATH = process.env.DATABASE_PATH || "./data/atlas.db";
const OPENALEX_API = "https://api.openalex.org/works";
const ARXIV_API = "https://export.arxiv.org/api/query";
const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1/paper/search";
const CROSSREF_API = "https://api.crossref.org/works";
const UNPAYWALL_API = "https://api.unpaywall.org/v2";

const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY;
const SEMANTIC_SCHOLAR_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || process.env.UNPAYWALL_EMAIL;
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL;
let semanticScholarNoticeShown = false;

const BUILTIN_QUERIES: Record<string, string> = {
  e2e: "end-to-end autonomous driving planning perception UniAD VAD SparseDrive",
  planning: "motion planning trajectory optimization model predictive control MPC",
  world_model: "world model autonomous driving simulation video generation DriveDreamer GenAD",
  llm_driving: "large language model autonomous driving decision making reasoning",
  control: "vehicle control path tracking lateral longitudinal steering",
  perception: "BEV perception 3D detection point cloud autonomous driving camera",
  prediction: "trajectory prediction motion forecasting interaction aware",
  rl_driving: "reinforcement learning autonomous driving policy simulation",
  racing: "autonomous racing high speed control RoboRacer Formula Student",
  safety: "autonomous driving safety verification robustness adversarial",
};

type PaperRecord = {
  title: string;
  abstract: string;
  year: number | null;
  publishedDate: string | null;
  venue: string;
  citations: number;
  citationPercentile: number | null;
  authors: string;
  doi: string | null;
  pdfUrl: string | null;
  openalexId: string | null;
  arxivId: string | null;
  semanticScholarId: string | null;
  sources: string[];
  sourceIds: Record<string, string>;
  sourceUrls: Record<string, string>;
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeDoi(doi: string | null) {
  return doi?.replace(/^https?:\/\/doi.org\//i, "").toLowerCase().trim() || null;
}

function extractAbstract(index: Record<string, number[]> | null) {
  if (!index) return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(" ").slice(0, 1200);
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceUrl(paper: any, source: string) {
  if (source === "OpenAlex") return paper.id;
  if (source === "Semantic Scholar") return paper.url || null;
  if (source === "arXiv") return `https://arxiv.org/abs/${paper.arxivId}`;
  return null;
}

async function fetchOpenAlex(query: string, directionKey: string, directionLabel: string): Promise<PaperRecord[]> {
  if (!OPENALEX_API_KEY) {
    console.log("  OpenAlex skipped: OPENALEX_API_KEY is not configured");
    return [];
  }
  const params = new URLSearchParams({
    search: query,
    per_page: "80",
    sort: "publication_date:desc,relevance_score:desc",
    select: "id,title,authorships,publication_year,publication_date,primary_location,cited_by_count,cited_by_percentile_year,abstract_inverted_index,doi,locations",
    api_key: OPENALEX_API_KEY,
  });
  try {
    const response = await fetch(`${OPENALEX_API}?${params}`);
    if (!response.ok) throw new Error(`OpenAlex ${response.status}`);
    const data = await response.json();
    return (data.results || []).filter((paper: any) => paper.title).map((paper: any) => {
      const venue = paper.primary_location?.source?.display_name || "";
      const authors = (paper.authorships || []).map((author: any) => author.author?.display_name).filter(Boolean).join(", ");
      const doi = normalizeDoi(paper.doi);
      const arxivLocation = paper.locations?.find((location: any) => location.pdf_url?.includes("arxiv"));
      return {
        title: paper.title,
        abstract: extractAbstract(paper.abstract_inverted_index),
        year: paper.publication_year || null,
        publishedDate: paper.publication_date || null,
        venue,
        citations: paper.cited_by_count || 0,
        citationPercentile: paper.cited_by_percentile_year?.max || paper.cited_by_percentile_year?.min || null,
        authors,
        doi,
        pdfUrl: arxivLocation?.pdf_url || paper.locations?.find((location: any) => location.pdf_url)?.pdf_url || null,
        openalexId: paper.id,
        arxivId: null,
        semanticScholarId: null,
        sources: ["OpenAlex"],
        sourceIds: { openalex: paper.id },
        sourceUrls: { OpenAlex: paper.id },
      };
    }).filter((paper: PaperRecord) => isLikelyRelevant(paper, directionKey, directionLabel, query)).slice(0, 30);
  } catch (error) {
    console.error(`  OpenAlex failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

async function fetchArxiv(query: string, directionKey: string, directionLabel: string): Promise<PaperRecord[]> {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: "0",
    max_results: "60",
    sortBy: "submittedDate",
    sortOrder: "descending",
  });
  try {
    const response = await fetch(`${ARXIV_API}?${params}`);
    if (!response.ok) throw new Error(`arXiv ${response.status}`);
    const xml = await response.text();
    const results: PaperRecord[] = [];
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    for (const entry of entries) {
      const id = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim().split("/abs/").pop();
      const title = decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
      if (!id || !title) continue;
      const summary = decodeXml(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "");
      const published = entry.match(/<published>(.*?)<\/published>/)?.[1] || "";
      const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
        .map((match) => decodeXml(match[1])).join(", ");
      const pdfUrl = entry.match(/<link[^>]+title="pdf"[^>]+href="([^"]+)"/)?.[1] || `https://arxiv.org/pdf/${id}.pdf`;
      results.push({
        title,
        abstract: summary,
        year: published ? new Date(published).getFullYear() : null,
        publishedDate: published || null,
        venue: "arXiv",
        citations: 0,
        citationPercentile: null,
        authors,
        doi: null,
        pdfUrl,
        openalexId: null,
        arxivId: id,
        semanticScholarId: null,
        sources: ["arXiv"],
        sourceIds: { arxiv: id },
        sourceUrls: { arXiv: `https://arxiv.org/abs/${id}` },
      });
    }
    return results.filter((paper) => isLikelyRelevant(paper, directionKey, directionLabel, query)).slice(0, 30);
  } catch (error) {
    console.error(`  arXiv failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

async function fetchSemanticScholar(query: string, directionKey: string, directionLabel: string): Promise<PaperRecord[]> {
  if (!SEMANTIC_SCHOLAR_API_KEY) {
    if (!semanticScholarNoticeShown) {
      console.log("  Semantic Scholar 未配置（可选），本次跳过补充引用数据");
      semanticScholarNoticeShown = true;
    }
    return [];
  }
  const params = new URLSearchParams({
    query,
    limit: "30",
    fields: "paperId,title,abstract,year,venue,citationCount,authors,externalIds,url,openAccessPdf",
  });
  try {
    const response = await fetch(`${SEMANTIC_SCHOLAR_API}?${params}`, {
      headers: { "x-api-key": SEMANTIC_SCHOLAR_API_KEY },
    });
    if (!response.ok) throw new Error(`Semantic Scholar ${response.status}`);
    const data = await response.json();
    return (data.data || []).filter((paper: any) => paper.title).map((paper: any) => {
      const doi = normalizeDoi(paper.externalIds?.DOI || null);
      const arxivId = paper.externalIds?.ArXiv || null;
      return {
        title: paper.title,
        abstract: paper.abstract || "",
        year: paper.year || null,
        publishedDate: paper.publicationDate || (paper.year ? `${paper.year}-01-01` : null),
        venue: paper.venue || "",
        citations: paper.citationCount || 0,
        citationPercentile: null,
        authors: (paper.authors || []).map((author: any) => author.name).join(", "),
        doi,
        pdfUrl: paper.openAccessPdf?.url || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null),
        openalexId: null,
        arxivId,
        semanticScholarId: paper.paperId,
        sources: ["Semantic Scholar"],
        sourceIds: { semanticScholar: paper.paperId },
        sourceUrls: { "Semantic Scholar": paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}` },
      };
    }).filter((paper: PaperRecord) => isLikelyRelevant(paper, directionKey, directionLabel, query)).slice(0, 30);
  } catch (error) {
    console.error(`  Semantic Scholar failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

async function enrichCrossref(paper: PaperRecord): Promise<PaperRecord> {
  if (!paper.doi || !CROSSREF_MAILTO) return paper;
  try {
    const response = await fetch(`${CROSSREF_API}/${encodeURIComponent(paper.doi)}?mailto=${encodeURIComponent(CROSSREF_MAILTO)}`);
    if (!response.ok) return paper;
    const message = (await response.json()).message || {};
    return {
      ...paper,
      title: paper.title || message.title?.[0] || "",
      year: paper.year || message.published?.["date-parts"]?.[0]?.[0] || null,
      publishedDate: paper.publishedDate || (message.published?.["date-parts"]?.[0]
        ? message.published["date-parts"][0].map((part: number) => String(part).padStart(2, "0")).join("-")
        : null),
      venue: paper.venue || message["container-title"]?.[0] || "",
      sourceIds: { ...paper.sourceIds, crossref: paper.doi },
      sourceUrls: { ...paper.sourceUrls, Crossref: `https://doi.org/${paper.doi}` },
      sources: [...new Set([...paper.sources, "Crossref"])],
    };
  } catch {
    return paper;
  }
}

async function enrichUnpaywall(paper: PaperRecord): Promise<PaperRecord> {
  if (!paper.doi || !UNPAYWALL_EMAIL || paper.pdfUrl) return paper;
  try {
    const response = await fetch(`${UNPAYWALL_API}/${encodeURIComponent(paper.doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`);
    if (!response.ok) return paper;
    const data = await response.json();
    const location = data.best_oa_location || data.oa_locations?.[0];
    if (!location?.url_for_pdf && !location?.url) return paper;
    return {
      ...paper,
      pdfUrl: location.url_for_pdf || location.url,
      sources: [...new Set([...paper.sources, "Unpaywall"])],
      sourceUrls: { ...paper.sourceUrls, Unpaywall: location.url_for_landing_page || location.url },
    };
  } catch {
    return paper;
  }
}

function ensureSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openalex_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      abstract TEXT,
      year INTEGER,
      venue TEXT,
      citations INTEGER DEFAULT 0,
      authors TEXT,
      doi TEXT,
      pdf_url TEXT,
      direction TEXT,
      direction_label TEXT,
      publication_channel TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS custom_directions (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      query TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const columns = new Set((db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name));
  const additions: Record<string, string> = {
    direction_label: "TEXT",
    publication_channel: "TEXT",
    arxiv_id: "TEXT",
    semantic_scholar_id: "TEXT",
    normalized_title: "TEXT",
    sources: "TEXT NOT NULL DEFAULT '[]'",
    source_ids: "TEXT NOT NULL DEFAULT '{}'",
    source_urls: "TEXT NOT NULL DEFAULT '{}'",
    embedding: "TEXT",
    embedding_model: "TEXT",
    summary_zh: "TEXT",
    innovations_zh: "TEXT NOT NULL DEFAULT '[]'",
    method_zh: "TEXT",
    results_zh: "TEXT",
    limitations_zh: "TEXT",
    summary_model: "TEXT",
    summary_source_hash: "TEXT",
    summary_updated_at: "TEXT",
    is_relevant: "INTEGER NOT NULL DEFAULT 1",
    published_date: "TEXT",
    citation_percentile: "REAL",
    venue_type: "TEXT NOT NULL DEFAULT 'unknown'",
    venue_tier: "INTEGER NOT NULL DEFAULT 0",
    is_frontier: "INTEGER NOT NULL DEFAULT 0",
    is_classic: "INTEGER NOT NULL DEFAULT 0",
    discovery_reason: "TEXT NOT NULL DEFAULT '方向相关'",
    recommendation_score: "REAL NOT NULL DEFAULT 0",
    last_seen_at: "TEXT",
  };
  for (const [column, type] of Object.entries(additions)) {
    if (!columns.has(column)) db.exec(`ALTER TABLE papers ADD COLUMN ${column} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_papers_normalized_title ON papers(normalized_title)");
  const backfill = db.prepare("SELECT id, title, year FROM papers WHERE normalized_title IS NULL OR normalized_title = ''").all() as { id: number; title: string; year: number | null }[];
  const updateTitle = db.prepare("UPDATE papers SET normalized_title = ? WHERE id = ?");
  for (const paper of backfill) updateTitle.run(normalizeTitle(paper.title), paper.id);
  const legacySources = db.prepare("SELECT id, openalex_id FROM papers WHERE (sources IS NULL OR sources = '[]') AND openalex_id LIKE 'https://openalex.org/%'").all() as { id: number; openalex_id: string }[];
  const backfillSources = db.prepare("UPDATE papers SET sources = ?, source_ids = ?, source_urls = ? WHERE id = ?");
  for (const paper of legacySources) {
    backfillSources.run(JSON.stringify(["OpenAlex"]), JSON.stringify({ openalex: paper.openalex_id }), JSON.stringify({ OpenAlex: paper.openalex_id }), paper.id);
  }
}

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function findExisting(db: Database.Database, paper: PaperRecord) {
  const doi = normalizeDoi(paper.doi);
  if (doi) {
    const row = db.prepare("SELECT * FROM papers WHERE lower(doi) = ? LIMIT 1").get(doi);
    if (row) return row as any;
  }
  for (const [column, value] of [["openalex_id", paper.openalexId], ["arxiv_id", paper.arxivId], ["semantic_scholar_id", paper.semanticScholarId]] as const) {
    if (!value) continue;
    const row = db.prepare(`SELECT * FROM papers WHERE ${column} = ? LIMIT 1`).get(value);
    if (row) return row as any;
  }
  return db.prepare("SELECT * FROM papers WHERE normalized_title = ? AND year = ? LIMIT 1").get(normalizeTitle(paper.title), paper.year) as any;
}

function upsertPaper(
  db: Database.Database,
  paper: PaperRecord,
  direction: { key: string; label: string },
  embeddingModel: string,
) {
  const existing = findExisting(db, paper);
  const currentSources = parseJson(existing?.sources, [] as string[]);
  const currentIds = parseJson(existing?.source_ids, {} as Record<string, string>);
  const currentUrls = parseJson(existing?.source_urls, {} as Record<string, string>);
  const mergedSources = [...new Set([...currentSources, ...paper.sources])];
  const mergedIds = { ...currentIds, ...paper.sourceIds };
  const mergedUrls = { ...currentUrls, ...paper.sourceUrls };
  const canonicalId = paper.openalexId || existing?.openalex_id || (paper.doi ? `doi:${paper.doi}` : paper.arxivId ? `arxiv:${paper.arxivId}` : `title:${normalizeTitle(paper.title)}:${paper.year || "unknown"}`);
  const publishedDate = existing?.published_date || paper.publishedDate || null;
  const citationPercentile = existing?.citation_percentile || paper.citationPercentile || null;
  const values = {
    openalex_id: canonicalId,
    title: existing?.title && existing.title.length >= paper.title.length ? existing.title : paper.title,
    abstract: (existing?.abstract || "").length >= paper.abstract.length ? existing?.abstract || "" : paper.abstract,
    year: existing?.year || paper.year,
    published_date: publishedDate,
    venue: existing?.venue && existing.venue !== "arXiv" ? existing.venue : paper.venue,
    citations: Math.max(existing?.citations || 0, paper.citations || 0),
    citation_percentile: citationPercentile,
    authors: (existing?.authors || "").length >= paper.authors.length ? existing?.authors || "" : paper.authors,
    doi: existing?.doi || paper.doi,
    pdf_url: existing?.pdf_url || paper.pdfUrl,
    direction: existing?.direction || direction.key,
    direction_label: existing?.direction_label || direction.label,
    publication_channel: existing?.publication_channel || (paper.venue === "arXiv" ? "arXiv 预印本" : "同行评议"),
    arxiv_id: existing?.arxiv_id || paper.arxivId,
    semantic_scholar_id: existing?.semantic_scholar_id || paper.semanticScholarId,
    normalized_title: normalizeTitle(paper.title),
    sources: JSON.stringify(mergedSources),
    source_ids: JSON.stringify(mergedIds),
    source_urls: JSON.stringify(mergedUrls),
    is_relevant: 1,
  };
  const metadata = metadataForPaper({
    title: values.title,
    year: values.year,
    published_date: values.published_date,
    venue: values.venue,
    publication_channel: values.publication_channel,
    citations: values.citations,
    citation_percentile: values.citation_percentile,
  });
  Object.assign(values, {
    venue_type: metadata.venueType,
    venue_tier: metadata.venueTier,
    is_frontier: metadata.isFrontier ? 1 : 0,
    is_classic: metadata.isClassic ? 1 : 0,
    discovery_reason: metadata.discoveryReason,
    recommendation_score: metadata.recommendationScore,
    last_seen_at: new Date().toISOString(),
  });
  if (existing) {
    db.prepare(`UPDATE papers SET title=@title, abstract=@abstract, year=@year, published_date=@published_date, venue=@venue, citations=@citations, citation_percentile=@citation_percentile, authors=@authors, doi=@doi, pdf_url=@pdf_url, direction=@direction, direction_label=@direction_label, publication_channel=@publication_channel, venue_type=@venue_type, venue_tier=@venue_tier, is_frontier=@is_frontier, is_classic=@is_classic, discovery_reason=@discovery_reason, recommendation_score=@recommendation_score, last_seen_at=@last_seen_at, arxiv_id=@arxiv_id, semantic_scholar_id=@semantic_scholar_id, normalized_title=@normalized_title, sources=@sources, source_ids=@source_ids, source_urls=@source_urls, is_relevant=@is_relevant, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({ ...values, id: existing.id });
    return {
      id: existing.id as number,
      needsEmbedding: !existing.embedding || existing.embedding_model !== embeddingModel,
    };
  } else {
    db.prepare(`INSERT OR IGNORE INTO papers (openalex_id,title,abstract,year,published_date,venue,citations,citation_percentile,authors,doi,pdf_url,direction,direction_label,publication_channel,venue_type,venue_tier,is_frontier,is_classic,discovery_reason,recommendation_score,last_seen_at,arxiv_id,semantic_scholar_id,normalized_title,sources,source_ids,source_urls,is_relevant) VALUES (@openalex_id,@title,@abstract,@year,@published_date,@venue,@citations,@citation_percentile,@authors,@doi,@pdf_url,@direction,@direction_label,@publication_channel,@venue_type,@venue_tier,@is_frontier,@is_classic,@discovery_reason,@recommendation_score,@last_seen_at,@arxiv_id,@semantic_scholar_id,@normalized_title,@sources,@source_ids,@source_urls,@is_relevant)`).run(values);
    const inserted = findExisting(db, paper);
    return { id: inserted.id as number, needsEmbedding: true };
  }
}

async function main() {
  const { EMBEDDING_MODEL, embedText, paperEmbeddingText } = await import("../src/lib/semantic-search");
  const db = new Database(DB_PATH);
  ensureSchema(db);
  const custom = db.prepare("SELECT key, label, query FROM custom_directions").all() as { key: string; label: string; query: string }[];
  const directions = [
    ...Object.entries(BUILTIN_QUERIES).map(([key, query]) => ({ key, label: key, query })),
    ...custom,
  ];
  let totalFetched = 0;
  let embeddingUnavailable = false;

  const saveEmbeddingIfNeeded = async (
    paper: PaperRecord,
    upserted: { id: number; needsEmbedding: boolean },
  ) => {
    if (!upserted.needsEmbedding || embeddingUnavailable) return;
    try {
      const embedding = await embedText(paperEmbeddingText(paper));
      db.prepare("UPDATE papers SET embedding = ?, embedding_model = ? WHERE id = ?")
        .run(JSON.stringify(embedding), EMBEDDING_MODEL, upserted.id);
    } catch (error) {
      embeddingUnavailable = true;
      console.error(`  语义向量暂不可用，将继续保存论文数据: ${error instanceof Error ? error.message : error}`);
    }
  };

  const builtinDirections = new Map(
    Object.entries(BUILTIN_QUERIES).map(([key]) => [key, { key, label: key }]),
  );
  for (const seed of CLASSIC_SEEDS) {
    for (const directionKey of seed.directions) {
      const direction = builtinDirections.get(directionKey);
      if (!direction) continue;
      const record: PaperRecord = {
        title: seed.title,
        abstract: "",
        year: seed.year,
        publishedDate: `${seed.year}-01-01`,
        venue: seed.venue,
        citations: 0,
        citationPercentile: null,
        authors: "",
        doi: seed.doi || null,
        pdfUrl: seed.arxivId ? `https://arxiv.org/pdf/${seed.arxivId}.pdf` : null,
        openalexId: null,
        arxivId: seed.arxivId || null,
        semanticScholarId: null,
        sources: ["Curated classics"],
        sourceIds: seed.arxivId ? { arxiv: seed.arxivId } : {},
        sourceUrls: seed.arxivId ? { arXiv: `https://arxiv.org/abs/${seed.arxivId}` } : {},
      };
      const upserted = upsertPaper(db, record, direction, EMBEDDING_MODEL);
      await saveEmbeddingIfNeeded(record, upserted);
      totalFetched += 1;
    }
  }

  for (const direction of directions) {
    console.log(`\n📚 ${direction.label} (${direction.key})`);
    const records = [
      ...(await fetchOpenAlex(direction.query, direction.key, direction.label)),
      ...(await fetchArxiv(direction.query, direction.key, direction.label)),
      ...(await fetchSemanticScholar(direction.query, direction.key, direction.label)),
    ];
    const deduped = new Map<string, PaperRecord>();
    for (const record of records) {
      const key = normalizeDoi(record.doi) || record.arxivId || record.semanticScholarId || record.openalexId || `${normalizeTitle(record.title)}:${record.year || "unknown"}`;
      const prior = deduped.get(key);
      deduped.set(key, prior ? { ...prior, ...record, abstract: record.abstract.length > prior.abstract.length ? record.abstract : prior.abstract, citations: Math.max(prior.citations, record.citations), sources: [...new Set([...prior.sources, ...record.sources])], sourceIds: { ...prior.sourceIds, ...record.sourceIds }, sourceUrls: { ...prior.sourceUrls, ...record.sourceUrls } } : record);
    }
    for (const record of deduped.values()) {
      const enriched = await enrichUnpaywall(await enrichCrossref(record));
      const upserted = upsertPaper(db, enriched, direction, EMBEDDING_MODEL);
      await saveEmbeddingIfNeeded(enriched, upserted);
      totalFetched += 1;
    }
    console.log(`  ✓ ${deduped.size} records merged`);
    await sleep(1000);
  }
  const total = (db.prepare("SELECT COUNT(*) as count FROM papers").get() as { count: number }).count;
  console.log(`\n✅ Multi-source sync complete: ${totalFetched} records processed, ${total} papers in DB`);
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
