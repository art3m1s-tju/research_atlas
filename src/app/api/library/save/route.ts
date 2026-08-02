import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";
import { ensureUserStateSchema } from "@/lib/user-state";
import { metadataForPaper } from "@/lib/research-ranking";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "缺少论文标题" }, { status: 400 });
  const db = new Database(DB_PATH);
  try {
    ensureUserStateSchema(db);
    ensureResearchFeatureSchema(db);
    const columns = new Set((db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name));
    if (!columns.has("arxiv_id")) db.exec("ALTER TABLE papers ADD COLUMN arxiv_id TEXT");
    const canonicalId = String(body.id || body.doi || `saved:${title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")}`);
    const existing = db.prepare("SELECT id FROM papers WHERE openalex_id = ? OR doi = ? LIMIT 1").get(canonicalId, body.doi || null) as { id: number } | undefined;
    let paperId = existing?.id;
    if (!paperId) {
      const metadata = metadataForPaper({ title, year: Number(body.year) || null, published_date: body.year ? `${body.year}-01-01` : null, venue: body.venue || "", publication_channel: body.venue || "", citations: Number(body.citations) || 0, sources: [String(body.source || "OpenAlex")] });
      const result = db.prepare(`
        INSERT INTO papers (
          openalex_id, title, abstract, year, venue, citations, authors, doi, pdf_url,
          direction, direction_label, publication_channel, arxiv_id, normalized_title,
          sources, source_ids, source_urls, is_relevant, venue_type, venue_tier,
          publication_status, venue_verified, venue_confidence, quality_score,
          is_frontier, is_classic, discovery_reason, recommendation_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        canonicalId, title, body.abstract || "", Number(body.year) || null, body.venue || "", Number(body.citations) || 0, body.authors || "", body.doi || null, body.pdfUrl || null,
        body.venue || "", title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ""), JSON.stringify([String(body.source || "OpenAlex")]), JSON.stringify({ external: canonicalId }), JSON.stringify({ [String(body.source || "OpenAlex")]: body.sourceUrl || canonicalId }),
        metadata.venueType, metadata.venueTier, metadata.publicationStatus, metadata.venueVerified ? 1 : 0, metadata.venueConfidence, metadata.qualityScore, metadata.isFrontier ? 1 : 0, metadata.isClassic ? 1 : 0, metadata.discoveryReason, metadata.recommendationScore,
      );
      paperId = Number(result.lastInsertRowid);
    }
    db.prepare("INSERT OR REPLACE INTO library_items (paper_id, source, external_key, collection) VALUES (?, ?, ?, ?)").run(paperId, body.source || "OpenAlex", canonicalId, "Atlas 收藏");
    db.prepare("INSERT INTO paper_user_events (paper_id, event) VALUES (?, 'save')").run(paperId);
    db.prepare(`
      INSERT INTO paper_user_state (paper_id, is_saved, updated_at)
      VALUES (?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(paper_id) DO UPDATE SET is_saved = 1, updated_at = CURRENT_TIMESTAMP
    `).run(paperId);
    return NextResponse.json({ success: true, paperId, id: canonicalId, alreadyExisted: Boolean(existing) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  } finally {
    db.close();
  }
}
