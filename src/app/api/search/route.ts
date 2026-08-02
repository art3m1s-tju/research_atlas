import { NextRequest, NextResponse } from "next/server";

const OPENALEX_API = "https://api.openalex.org/works";

async function fetchWithTimeout(url: string, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function abstractFromInvertedIndex(index: Record<string, number[]> | null) {
  if (!index) return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) for (const position of positions) words.push([position, word]);
  return words.sort((left, right) => left[0] - right[0]).map(([, word]) => word).join(" ");
}

export async function GET(request: NextRequest) {
  const query = new URL(request.url).searchParams.get("query")?.trim() || "";
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit") || 20), 1), 50);
  if (query.length < 2) return NextResponse.json({ papers: [], error: "搜索词至少 2 个字符" }, { status: 400 });
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
    sort: "relevance_score:desc",
    select: "id,title,authorships,publication_year,publication_date,primary_location,cited_by_count,abstract_inverted_index,doi,open_access,locations,ids",
  });
  if (process.env.OPENALEX_API_KEY) params.set("api_key", process.env.OPENALEX_API_KEY);
  try {
    const response = await fetchWithTimeout(`${OPENALEX_API}?${params}`);
    if (!response.ok) {
      const detail = response.status === 429 ? "OpenAlex 当前额度或速率限制已用尽，请稍后再试或更新 API 配额" : `OpenAlex ${response.status}`;
      return NextResponse.json({ papers: [], error: detail }, { status: response.status });
    }
    const data = await response.json();
    const papers = (data.results || []).map((paper: any) => ({
      id: paper.id,
      title: paper.title || "未命名论文",
      authors: (paper.authorships || []).slice(0, 8).map((item: any) => item.author?.display_name).filter(Boolean).join(", "),
      year: paper.publication_year || null,
      venue: paper.primary_location?.source?.display_name || "",
      citations: paper.cited_by_count || 0,
      abstract: abstractFromInvertedIndex(paper.abstract_inverted_index),
      doi: paper.doi || null,
      pdfUrl: paper.open_access?.oa_url || paper.locations?.find((location: any) => location.pdf_url)?.pdf_url || null,
      sourceUrl: paper.id,
      source: "OpenAlex",
      isExternal: true,
    }));
    return NextResponse.json({ papers, total: data.meta?.count || papers.length, source: "OpenAlex", query });
  } catch (error) {
    return NextResponse.json({ papers: [], error: String(error) }, { status: 500 });
  }
}
