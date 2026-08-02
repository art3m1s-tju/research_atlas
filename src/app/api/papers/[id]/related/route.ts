import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { cosineSimilarity, lexicalScore, parseEmbedding } from "@/lib/semantic-search";
import { ensureResearchFeatureSchema } from "@/lib/research-features";
import { ensureUserStateSchema } from "@/lib/user-state";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY;

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function compactPaper(paper: any, relation: string, score = 0, local = false) {
  return {
    id: paper.openalex_id || paper.id,
    title: paper.title,
    authors: paper.authors || "",
    year: paper.year || paper.publication_year || null,
    venue: paper.venue || paper.primary_location?.source?.display_name || "",
    citations: paper.citations ?? paper.cited_by_count ?? 0,
    abstract: paper.abstract || "",
    doi: paper.doi || null,
    pdfUrl: paper.pdf_url || paper.open_access?.oa_url || null,
    relation,
    score,
    local,
  };
}

async function openAlexWorks(ids: string[]) {
  if (!ids.length) return [];
  const params = new URLSearchParams({
    filter: `openalex_id:${ids.join("|")}`,
    per_page: String(Math.min(ids.length, 20)),
    select: "id,title,publication_year,primary_location,cited_by_count,doi,open_access",
  });
  if (OPENALEX_API_KEY) params.set("api_key", OPENALEX_API_KEY);
  const response = await fetch(`https://api.openalex.org/works?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) return [];
  const data = await response.json();
  return data.results || [];
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = new Database(DB_PATH);
  try {
    ensureUserStateSchema(db);
    ensureResearchFeatureSchema(db);
    const paper = db.prepare("SELECT * FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as any;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const directionRows = db.prepare("SELECT direction FROM paper_directions WHERE paper_id = ? AND is_relevant != 0").all(paper.id) as { direction: string }[];
    const directionKeys = directionRows.map((row) => row.direction);
    const candidates = db.prepare(`
      SELECT DISTINCT p.*
      FROM papers p
      JOIN paper_directions pd ON pd.paper_id = p.id AND pd.is_relevant != 0
      WHERE p.id != ?
        AND (p.is_relevant IS NULL OR p.is_relevant != 0)
        AND NOT EXISTS (SELECT 1 FROM paper_user_state s WHERE s.paper_id = p.id AND s.is_hidden = 1)
        AND (${directionKeys.length ? `pd.direction IN (${directionKeys.map(() => "?").join(",")})` : "1 = 1"})
      LIMIT 300
    `).all(paper.id, ...directionKeys) as any[];
    const targetEmbedding = parseEmbedding(paper.embedding);
    const targetText = [paper.title, paper.abstract, paper.venue].filter(Boolean).join(" ");
    const similar = candidates.map((candidate) => {
      const candidateEmbedding = parseEmbedding(candidate.embedding);
      const semantic = targetEmbedding && candidateEmbedding ? Math.max(0, cosineSimilarity(targetEmbedding, candidateEmbedding)) : 0;
      const lexical = lexicalScore([candidate.title, candidate.abstract, candidate.venue].filter(Boolean).join(" "), targetText);
      return { paper: candidate, score: semantic * 0.8 + lexical * 0.2 };
    }).sort((left, right) => right.score - left.score).slice(0, 8);
    const relationRows = similar.map(({ paper: candidate, score }) => ({
      ...compactPaper(candidate, "similar", score, true),
      relationReason: "标题/摘要语义相似，且属于相同研究方向",
    }));

    let citedBy: any[] = [];
    let references: any[] = [];
    const openAlexId = String(paper.openalex_id || "").match(/(?:openalex\.org\/)?(W\d+)/i)?.[1];
    if (openAlexId) {
      const params = new URLSearchParams({ select: "id,referenced_works,related_works", per_page: "1" });
      if (OPENALEX_API_KEY) params.set("api_key", OPENALEX_API_KEY);
      const response = await fetch(`https://api.openalex.org/works/${openAlexId}?${params}`, { signal: AbortSignal.timeout(12000) }).catch(() => null);
      if (response?.ok) {
        const work = await response.json();
        const referencedIds = (work.referenced_works || []).slice(0, 8).map((value: string) => value.split("/").pop()).filter(Boolean);
        references = (await openAlexWorks(referencedIds)).map((item: any) => compactPaper({ ...item, openalex_id: item.id }, "reference"));
        const citedParams = new URLSearchParams({ filter: `cites:${openAlexId}`, per_page: "8", select: "id,title,publication_year,primary_location,cited_by_count,doi,open_access" });
        if (OPENALEX_API_KEY) citedParams.set("api_key", OPENALEX_API_KEY);
        const citedResponse = await fetch(`https://api.openalex.org/works?${citedParams}`, { signal: AbortSignal.timeout(12000) }).catch(() => null);
        if (citedResponse?.ok) {
          const citedData = await citedResponse.json();
          citedBy = (citedData.results || []).map((item: any) => compactPaper({ ...item, openalex_id: item.id }, "cited_by"));
        }
      }
    }
    return NextResponse.json({
      similar: relationRows,
      citedBy,
      references,
      message: openAlexId ? "相似论文来自本地论文库；引用关系来自 OpenAlex" : "当前论文没有可用的 OpenAlex 标识，暂时只返回本地相似论文",
    });
  } catch (error) {
    return NextResponse.json({ error: String(error), similar: [], citedBy: [], references: [] }, { status: 500 });
  } finally {
    db.close();
  }
}
