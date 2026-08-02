import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { ensureUserStateSchema } from "@/lib/user-state";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = new Database(DB_PATH);
  try {
    ensureUserStateSchema(db);
    const paper = db.prepare("SELECT * FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as any;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const directions = db.prepare(`
      SELECT direction as key, direction_label as label
      FROM paper_directions
      WHERE paper_id = ? AND is_relevant != 0
    `).all(paper.id);
    const userState = db.prepare("SELECT is_read, is_saved, is_hidden, note FROM paper_user_state WHERE paper_id = ?").get(paper.id) || {
      is_read: 0, is_saved: 0, is_hidden: 0, note: "",
    };
    return NextResponse.json({
      paper: {
        dbId: paper.id,
        id: paper.openalex_id,
        title: paper.title,
        authors: paper.authors || "",
        year: paper.year,
        venue: paper.venue || "",
        citations: paper.citations || 0,
        abstract: paper.abstract || "",
        doi: paper.doi,
        pdfUrl: paper.pdf_url,
        sources: parseJson(paper.sources, []),
        sourceUrls: parseJson(paper.source_urls, {}),
        directions,
        summaryZh: paper.summary_zh || null,
        innovationsZh: parseJson(paper.innovations_zh, []),
        methodZh: paper.method_zh || null,
        resultsZh: paper.results_zh || null,
        limitationsZh: paper.limitations_zh || null,
        publicationStatus: paper.publication_status || "unknown",
        venueTier: paper.venue_tier || 0,
        venueVerified: Boolean(paper.venue_verified),
        venueConfidence: paper.venue_confidence || 0,
        discoveryReason: paper.discovery_reason || "方向相关",
        userState: {
          isRead: Boolean((userState as any).is_read),
          isSaved: Boolean((userState as any).is_saved),
          isHidden: Boolean((userState as any).is_hidden),
          note: (userState as any).note || "",
        },
      },
    });
  } finally {
    db.close();
  }
}
