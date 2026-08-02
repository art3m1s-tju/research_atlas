import Database from "better-sqlite3";

const OPENALEX_API = "https://api.openalex.org/works";
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY;

// 根据你的研究方向定制的检索关键词
const DIRECTION_QUERIES: Record<string, string> = {
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function initDB(dbPath: string) {
  const db = new Database(dbPath);
  
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  return db;
}

async function fetchOpenAlex(query: string, perPage = 20): Promise<any[]> {
  const params = new URLSearchParams({
    search: query,
    per_page: String(perPage),
    sort: "cited_by_count:desc",
    select: "id,title,authorships,publication_year,primary_location,cited_by_count,abstract_inverted_index,doi,locations",
  });
  if (OPENALEX_API_KEY) params.set("api_key", OPENALEX_API_KEY);

  try {
    const response = await fetch(`${OPENALEX_API}?${params}`);
    if (!response.ok) {
      console.error(`OpenAlex API error: ${response.status}`);
      return [];
    }
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error("Fetch error:", error);
    return [];
  }
}

function extractAbstract(invertedIndex: any): string {
  if (!invertedIndex) return "";
  const wordPositions: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions as number[]) {
      wordPositions.push([pos, word]);
    }
  }
  wordPositions.sort((a, b) => a[0] - b[0]);
  return wordPositions.map(([_, word]) => word).join(" ");
}

async function syncPapers() {
  const dbPath = "./data/atlas.db";
  const db = initDB(dbPath);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO papers 
    (openalex_id, title, abstract, year, venue, citations, authors, doi, pdf_url, direction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  console.log("开始同步论文数据...\n");

  for (const [direction, query] of Object.entries(DIRECTION_QUERIES)) {
    console.log(`📚 方向: ${direction}`);
    console.log(`   查询: ${query}`);
    
    const papers = await fetchOpenAlex(query, 20);
    console.log(`   获取到 ${papers.length} 篇论文`);

    for (const paper of papers) {
      const title = paper.title || "";
      const year = paper.publication_year;
      const venue = paper.primary_location?.source?.display_name || "";
      const citations = paper.cited_by_count || 0;
      const authors = (paper.authorships || [])
        .map((a: any) => a.author?.display_name)
        .filter(Boolean)
        .join(", ");
      const doi = paper.doi || null;
      const abstract = extractAbstract(paper.abstract_inverted_index);
      
      let pdfUrl = null;
      if (paper.locations && Array.isArray(paper.locations)) {
        for (const loc of paper.locations) {
          if (loc.pdf_url && loc.pdf_url.includes("arxiv")) {
            pdfUrl = loc.pdf_url;
            break;
          }
        }
      }

      try {
        insert.run(
          paper.id,
          title,
          abstract,
          year,
          venue,
          citations,
          authors,
          doi,
          pdfUrl,
          direction
        );
      } catch (error) {
        console.error(`   ❌ 插入失败: ${title.substring(0, 50)}`);
      }
    }

    console.log(`   ✓ 完成\n`);
    await sleep(1000); // 避免请求过快
  }

  const total = db.prepare("SELECT COUNT(*) as count FROM papers").get() as any;
  console.log(`\n✅ 同步完成！数据库共 ${total.count} 篇论文`);
  
  db.close();
}

syncPapers().catch(console.error);
