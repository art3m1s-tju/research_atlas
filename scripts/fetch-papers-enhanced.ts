import Database from "better-sqlite3";

const OPENALEX_API = "https://api.openalex.org/works";

// 扩展研究方向查询，特别是 racing 和 llm_driving
const DIRECTION_QUERIES: Record<string, string[]> = {
  e2e: [
    "end-to-end autonomous driving planning perception UniAD VAD SparseDrive",
    "end-to-end learning autonomous driving neural network policy",
    "imitation learning autonomous driving behavior cloning"
  ],
  planning: [
    "motion planning trajectory optimization model predictive control MPC",
    "path planning autonomous vehicle A* RRT sampling-based",
    "trajectory planning autonomous driving optimization"
  ],
  world_model: [
    "world model autonomous driving simulation video generation DriveDreamer GenAD",
    "video generation driving scene prediction future state",
    "driving simulator neural network generative model"
  ],
  llm_driving: [
    "large language model autonomous driving decision making reasoning",
    "GPT vision language model driving understanding",
    "LLM traffic scene understanding autonomous vehicle",
    "multimodal large model autonomous driving planning"
  ],
  control: [
    "vehicle control path tracking lateral longitudinal steering",
    "PID control autonomous driving steering acceleration",
    "adaptive cruise control lane keeping autonomous"
  ],
  perception: [
    "BEV perception 3D detection point cloud autonomous driving camera",
    "bird's eye view perception multi-camera fusion",
    "3D object detection LiDAR camera fusion autonomous"
  ],
  prediction: [
    "trajectory prediction motion forecasting interaction aware",
    "pedestrian trajectory prediction social interaction",
    "vehicle motion prediction traffic scene"
  ],
  rl_driving: [
    "reinforcement learning autonomous driving policy simulation",
    "deep reinforcement learning driving policy optimization",
    "multi-agent reinforcement learning traffic"
  ],
  racing: [
    "autonomous racing high speed control Formula Student",
    "racing car autonomous control trajectory optimization",
    "high speed vehicle control lateral dynamics",
    "autonomous race car planning control",
    "Formula Student Driverless competition",
    "racing line optimization autonomous vehicle",
    "high performance driving neural network",
    "motorsport autonomous control system"
  ],
  safety: [
    "autonomous driving safety verification robustness adversarial",
    "autonomous vehicle safety critical scenario testing",
    "robustness neural network autonomous driving"
  ],
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
    mailto: "ai-research-atlas@example.com",
  });

  const url = `${OPENALEX_API}?${params}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`    ❌ OpenAlex: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.results || [];
  } catch (e) {
    console.error(`    ❌ Error: ${e}`);
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

function inferCCFRank(venue: string): string | null {
  const topVenues = [
    "NeurIPS", "ICML", "ICLR", "CVPR", "ICCV", "ECCV",
    "ACL", "EMNLP", "NAACL", "AAAI", "ICRA", "RSS"
  ];
  
  for (const top of topVenues) {
    if (venue.toLowerCase().includes(top.toLowerCase())) {
      return "A";
    }
  }
  return null;
}

function inferPublicationChannel(venue: string, year: number | null): string {
  if (!venue) return "arXiv 预印本";
  
  const ccfRank = inferCCFRank(venue);
  if (ccfRank === "A") return "CCF A";
  if (ccfRank === "B") return "CCF B";
  
  if (year && new Date().getFullYear() - year <= 1) {
    return "同行评议";
  }
  
  return "同行评议";
}

async function main() {
  const dbPath = process.argv[2] || "./data/atlas.db";
  console.log(`\n🚀 Enhanced paper sync using OpenAlex API`);
  console.log(`📁 Database: ${dbPath}\n`);

  const db = initDB(dbPath);
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO papers 
    (openalex_id, title, abstract, year, venue, citations, authors, doi, pdf_url, direction, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const directionCounts: Record<string, number> = {};

  for (const [direction, queries] of Object.entries(DIRECTION_QUERIES)) {
    console.log(`\n📚 ${direction} (${queries.length} queries)`);
    
    let inserted = 0;
    const seen = new Set<string>();

    for (const query of queries) {
      console.log(`   Query: "${query.substring(0, 60)}..."`);
      const papers = await fetchOpenAlex(query, 20);
      
      for (const paper of papers) {
        if (seen.has(paper.id)) continue;
        seen.add(paper.id);

        const title = paper.title;
        const abstract = extractAbstract(paper.abstract_inverted_index);
        const year = paper.publication_year;
        const venue = paper.primary_location?.source?.display_name || "";
        const citations = paper.cited_by_count || 0;
        const authors = (paper.authorships || []).map((a: any) => a.author?.display_name).join(", ");
        const doi = paper.doi || null;
        
        let pdfUrl = null;
        if (paper.locations && Array.isArray(paper.locations)) {
          const arxivLoc = paper.locations.find((l: any) => 
            l.landing_page_url && l.landing_page_url.includes("arxiv")
          );
          if (arxivLoc?.pdf_url) {
            pdfUrl = arxivLoc.pdf_url;
          }
        }

        insertStmt.run(
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
        inserted++;
      }
      
      await sleep(1000);
    }
    
    directionCounts[direction] = inserted;
    console.log(`   ✓ Inserted ${inserted} papers`);
  }

  const total = db.prepare("SELECT COUNT(*) as count FROM papers").get() as { count: number };
  
  console.log(`\n✅ Sync complete!`);
  console.log(`📊 Total papers in database: ${total.count}`);
  console.log(`\nBreakdown by direction:`);
  for (const [dir, count] of Object.entries(directionCounts)) {
    console.log(`  ${dir}: ${count}`);
  }
  
  db.close();
}

main().catch(console.error);
