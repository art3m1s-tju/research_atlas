import Database from "better-sqlite3";

const OPENALEX_API = "https://api.openalex.org/works";
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY;

function abstractFromIndex(index: Record<string, number[]> | null) {
  if (!index) return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(" ").slice(0, 600);
}

function pdfUrlFor(paper: any) {
  const arxiv = paper.locations?.find((location: any) => location.pdf_url?.includes("arxiv"));
  return arxiv?.pdf_url || paper.locations?.find((location: any) => location.pdf_url)?.pdf_url || null;
}

function relevant(paper: any, query: string) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  const title = String(paper.title || "").toLowerCase();
  const abstract = abstractFromIndex(paper.abstract_inverted_index).toLowerCase();
  const score = terms.reduce((total, term) => total + (title.includes(term) ? 5 : abstract.includes(term) ? 1 : 0), 0);
  return terms.length < 2 || score >= Math.max(2, Math.ceil(terms.length / 2));
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
  return (data.results || []).filter((paper: any) => relevant(paper, query));
}

async function main() {
  const db = new Database("./data/atlas.db");
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
  const directions = db.prepare("SELECT key, label, query FROM custom_directions").all() as { key: string; label: string; query: string }[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO papers
    (openalex_id, title, abstract, year, venue, citations, authors, doi, pdf_url, direction, direction_label, publication_channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const direction of directions) {
    try {
      const papers = await fetchPapers(direction.query);
      const insertMany = db.transaction((items: any[]) => {
        for (const paper of items) {
          const venue = paper.primary_location?.source?.display_name || "";
          const authors = (paper.authorships || []).map((author: any) => author.author?.display_name).filter(Boolean).join(", ");
          const upperVenue = venue.toUpperCase();
          const channel = upperVenue.includes("ARXIV") ? "arXiv 预印本" : "同行评议";
          insert.run(
            paper.id,
            paper.title,
            abstractFromIndex(paper.abstract_inverted_index),
            paper.publication_year,
            venue,
            paper.cited_by_count || 0,
            authors,
            paper.doi || null,
            pdfUrlFor(paper),
            direction.key,
            direction.label,
            channel
          );
        }
      });
      insertMany(papers);
      console.log(`${direction.label}: ${papers.length} fetched`);
    } catch (error) {
      console.error(`${direction.label}: ${error instanceof Error ? error.message : error}`);
    }
  }

  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
