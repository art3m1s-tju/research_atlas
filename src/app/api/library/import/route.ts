import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { BUILTIN_DIRECTION_LABELS, metadataForPaper } from "@/lib/research-ranking";
import { isLikelyRelevant } from "@/lib/relevance";
import { ensureUserStateSchema } from "@/lib/user-state";
import { ensureResearchFeatureSchema } from "@/lib/research-features";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

function clean(value: string) {
  return value.replace(/^\s*[{"']|[}"']\s*$/g, "").replace(/\\([{}",])/g, "$1").trim();
}

function parseBibtex(input: string) {
  const entries: Array<Record<string, string>> = [];
  const pattern = /@([a-z]+)\s*\{\s*([^,]+),([\s\S]*?)\n\s*\}/gi;
  for (const match of input.matchAll(pattern)) {
    const fields: Record<string, string> = { entryType: match[1], citationKey: match[2].trim() };
    const fieldPattern = /([a-z][a-z0-9_-]*)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"(?:[^"\\]|\\.)*"|[^,\n]+)/gi;
    for (const field of match[3].matchAll(fieldPattern)) fields[field[1].toLowerCase()] = clean(field[2]);
    if (fields.title) entries.push(fields);
  }
  return entries;
}

function yearOf(entry: Record<string, string>) {
  const value = Number(entry.year || entry.date?.slice(0, 4));
  return Number.isFinite(value) ? value : null;
}

function arxivIdOf(entry: Record<string, string>) {
  const value = entry.eprint || entry.arxivid || entry.arxiv || "";
  const url = entry.url || "";
  const match = `${value} ${url}`.match(/(?:arxiv(?:\.org)?\/(?:abs|pdf)\/|arxiv:)([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i);
  return match?.[1] || (value.match(/[0-9]{4}\.[0-9]{4,5}(?:v\d+)?/) || [])[0] || null;
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
    CREATE TABLE IF NOT EXISTS paper_directions (
      paper_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      direction_label TEXT NOT NULL,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paper_id, direction)
    );
  `);
  const additions: Record<string, string> = {
    published_date: "TEXT", arxiv_id: "TEXT", normalized_title: "TEXT", sources: "TEXT NOT NULL DEFAULT '[]'",
    source_ids: "TEXT NOT NULL DEFAULT '{}'", source_urls: "TEXT NOT NULL DEFAULT '{}'", is_relevant: "INTEGER NOT NULL DEFAULT 1",
    venue_type: "TEXT NOT NULL DEFAULT 'unknown'", venue_tier: "INTEGER NOT NULL DEFAULT 0", publication_status: "TEXT NOT NULL DEFAULT 'unknown'",
    venue_verified: "INTEGER NOT NULL DEFAULT 0", venue_confidence: "REAL NOT NULL DEFAULT 0", quality_score: "REAL NOT NULL DEFAULT 0",
    is_frontier: "INTEGER NOT NULL DEFAULT 0", is_classic: "INTEGER NOT NULL DEFAULT 0", discovery_reason: "TEXT NOT NULL DEFAULT '方向相关'",
    recommendation_score: "REAL NOT NULL DEFAULT 0",
  };
  const columns = new Set((db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name));
  for (const [column, type] of Object.entries(additions)) if (!columns.has(column)) db.exec(`ALTER TABLE papers ADD COLUMN ${column} ${type}`);
  ensureUserStateSchema(db);
  ensureResearchFeatureSchema(db);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const bibtex = typeof body.bibtex === "string" ? body.bibtex : "";
  const collection = typeof body.collection === "string" ? body.collection.trim() : "Zotero Library";
  if (!bibtex.trim()) return NextResponse.json({ error: "没有收到 BibTeX 内容" }, { status: 400 });
  const entries = parseBibtex(bibtex);
  if (!entries.length) return NextResponse.json({ error: "没有解析出包含 title 的 BibTeX 条目" }, { status: 400 });

  const db = new Database(DB_PATH);
  try {
    ensureSchema(db);
    const insertPaper = db.prepare(`
      INSERT INTO papers (
        openalex_id, title, abstract, year, venue, citations, authors, doi, pdf_url,
        direction, direction_label, publication_channel, arxiv_id, normalized_title,
        sources, source_ids, source_urls, is_relevant, venue_type, venue_tier,
        publication_status, venue_verified, venue_confidence, quality_score,
        is_frontier, is_classic, discovery_reason, recommendation_score
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    let linked = 0;
    let duplicates = 0;
    const transaction = db.transaction(() => {
      for (const entry of entries) {
        const title = clean(entry.title);
        const year = yearOf(entry);
        const doi = clean(entry.doi || "") || null;
        const arxivId = arxivIdOf(entry);
        const existing = db.prepare(`
          SELECT * FROM papers
          WHERE (? IS NOT NULL AND lower(doi) = lower(?))
             OR (? IS NOT NULL AND arxiv_id = ?)
             OR (normalized_title = ? AND year IS ?)
          LIMIT 1
        `).get(doi, doi, arxivId, arxivId, title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ""), year) as any;
        let paperId: number;
        if (existing) {
          paperId = existing.id;
          duplicates += 1;
        } else {
          const abstract = clean(entry.abstract || "");
          const venue = clean(entry.booktitle || entry.journal || entry.publisher || "");
          const authors = clean(entry.author || "");
          const pdfUrl = entry.pdf || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null);
          const canonicalId = arxivId ? `arxiv:${arxivId}` : doi ? `doi:${doi}` : `bibtex:${entry.citationKey}`;
          const metadata = metadataForPaper({ title, year, published_date: year ? `${year}-01-01` : null, venue, publication_channel: venue, citations: 0, sources: ["BibTeX"] });
          const result = insertPaper.run(
            canonicalId, title, abstract, year, venue, authors, doi, pdfUrl, null, null, venue, arxivId,
            title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ""), JSON.stringify(["BibTeX"]), JSON.stringify({ bibtex: entry.citationKey }), JSON.stringify({ BibTeX: entry.url || "" }),
            metadata.venueType, metadata.venueTier, metadata.publicationStatus, metadata.venueVerified ? 1 : 0, metadata.venueConfidence, metadata.qualityScore,
            metadata.isFrontier ? 1 : 0, metadata.isClassic ? 1 : 0, metadata.discoveryReason, metadata.recommendationScore,
          );
          paperId = Number(result.lastInsertRowid);
          inserted += 1;
        }
        db.prepare(`
          INSERT INTO library_items (paper_id, source, external_key, collection)
          VALUES (?, 'Zotero/BibTeX', ?, ?)
          ON CONFLICT(paper_id) DO UPDATE SET collection = excluded.collection, imported_at = CURRENT_TIMESTAMP
        `).run(paperId, entry.citationKey, collection);
        const row = db.prepare("SELECT title, abstract, venue FROM papers WHERE id = ?").get(paperId) as any;
        for (const [direction, label] of Object.entries(BUILTIN_DIRECTION_LABELS)) {
          if (!isLikelyRelevant(row, direction, label, label)) continue;
          db.prepare(`
            INSERT OR IGNORE INTO paper_directions (paper_id, direction, direction_label, is_relevant)
            VALUES (?, ?, ?, 1)
          `).run(paperId, direction, label);
          linked += 1;
        }
        db.prepare("INSERT INTO paper_user_events (paper_id, event) VALUES (?, 'library_import')").run(paperId);
      }
    });
    transaction();
    return NextResponse.json({ success: true, entries: entries.length, inserted, duplicates, directionsLinked: linked, collection });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  } finally {
    db.close();
  }
}
