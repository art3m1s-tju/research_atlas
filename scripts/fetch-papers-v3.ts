import Database from "better-sqlite3";

const OPENALEX_API = "https://api.openalex.org/works";

// 每个方向多个精准查询
const DIRECTION_QUERIES: Record<string, { label: string; queries: string[] }> = {
  e2e: {
    label: "端到端自动驾驶",
    queries: [
      "end-to-end autonomous driving",
      "imitation learning driving",
      "behavior cloning driving",
      "learning to drive",
      "end-to-end planning perception",
    ]
  },
  planning: {
    label: "运动规划",
    queries: [
      "motion planning autonomous vehicle",
      "trajectory planning autonomous driving",
      "path planning robot navigation",
      "sampling-based motion planning",
    ]
  },
  world_model: {
    label: "世界模型",
    queries: [
      "world model autonomous driving",
      "world model driving simulation",
      "video generation driving scene",
      "driving world model",
      "neural scene representation driving",
    ]
  },
  llm_driving: {
    label: "大模型驾驶",
    queries: [
      "large language model autonomous driving",
      "vision language model driving",
      "multimodal large model driving",
      "GPT autonomous vehicle",
      "language model traffic understanding",
    ]
  },
  control: {
    label: "规划与控制",
    queries: [
      "model predictive control autonomous vehicle",
      "trajectory tracking autonomous driving",
      "lateral control autonomous vehicle",
      "adaptive cruise control",
      "autonomous vehicle control system",
    ]
  },
  perception: {
    label: "BEV 感知",
    queries: [
      "bird eye view perception",
      "BEV detection autonomous driving",
      "multi-camera 3D perception",
      "3D object detection camera lidar",
      "monocular 3D detection autonomous",
    ]
  },
  prediction: {
    label: "轨迹预测",
    queries: [
      "trajectory prediction autonomous driving",
      "motion forecasting vehicle",
      "interaction aware trajectory prediction",
      "pedestrian trajectory prediction",
    ]
  },
  rl_driving: {
    label: "强化学习驾驶",
    queries: [
      "reinforcement learning autonomous driving",
      "deep reinforcement learning driving",
      "multi-agent reinforcement learning traffic",
    ]
  },
  racing: {
    label: "自动驾驶竞赛",
    queries: [
      "autonomous racing",
      "racing car autonomous control",
      "autonomous race car",
      "Formula Student driverless",
      "high speed autonomous vehicle control",
      "racing line optimization",
      "minimum time racing trajectory",
      "vehicle dynamics racing",
      "autonomous drone racing",
      "Indy autonomous challenge",
      "RoboRace autonomous",
      "model predictive control racing",
    ]
  },
  safety: {
    label: "安全与验证",
    queries: [
      "autonomous driving safety",
      "autonomous vehicle verification",
      "safety critical autonomous driving",
      "adversarial attack autonomous driving",
    ]
  }
};

const SLEEP_BETWEEN = 1200;
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(query: string, perPage = 25, sort = "cited_by_count:desc"): Promise<any[]> {
  const params = new URLSearchParams({
    search: query,
    per_page: String(perPage),
    sort,
    select: "id,title,authorships,publication_year,primary_location,cited_by_count,abstract_inverted_index,doi,locations",
    mailto: "ai-research-atlas@example.com"
  });
  try {
    const res = await fetch(`${OPENALEX_API}?${params}`);
    if (!res.ok) {
      if (res.status === 429) { await sleep(3000); return fetchPage(query, perPage, sort); }
      return [];
    }
    const data = await res.json();
    return data.results || [];
  } catch { return []; }
}

function extractAbstract(inv: any): string {
  if (!inv) return "";
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions as number[]) words.push([pos, word]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(w => w[1]).join(" ").substring(0, 500);
}

function extractPdfUrl(paper: any): string | null {
  if (paper.locations) {
    for (const loc of paper.locations) {
      if (loc.pdf_url && loc.pdf_url.includes("arxiv")) return loc.pdf_url;
    }
    for (const loc of paper.locations) {
      if (loc.pdf_url) return loc.pdf_url;
    }
  }
  if (paper.doi && paper.doi.includes("arxiv")) {
    const id = paper.doi.split("arxiv/")[1];
    if (id) return `https://arxiv.org/pdf/${id}.pdf`;
  }
  return null;
}

async function main() {
  const db = new Database("./data/atlas.db");
  db.exec(`
    DROP TABLE IF EXISTS papers;
    CREATE TABLE papers (
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
    CREATE INDEX IF NOT EXISTS idx_papers_direction ON papers(direction);
    CREATE INDEX IF NOT EXISTS idx_papers_citations ON papers(citations DESC);
  `);

  console.log("🚀 V3: 精准论文同步\n");

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO papers 
    (openalex_id, title, abstract, year, venue, citations, authors, doi, pdf_url, direction, direction_label, publication_channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertBatch = db.transaction((papers: any[], dir: string, label: string) => {
    let c = 0;
    for (const p of papers) {
      if (!p.title) continue;
      const venue = p.primary_location?.source?.display_name || "";
      const authors = (p.authorships || []).map((a: any) => a.author?.display_name).join(", ");
      const vu = venue.toUpperCase();
      const channel = vu.includes("ARXIV") ? "arXiv 预印本" : 
        ["CVPR","ICCV","ECCV","NEURIPS","ICML","ICLR","AAAI","ACL","EMNLP"].some(t => vu.includes(t)) ? "CCF A" : "同行评议";
      insertStmt.run(p.id, p.title, extractAbstract(p.abstract_inverted_index),
        p.publication_year, venue, p.cited_by_count || 0, authors,
        p.doi, extractPdfUrl(p), dir, label, channel);
      c++;
    }
    return c;
  });

  let grandTotal = 0;
  for (const [dir, config] of Object.entries(DIRECTION_QUERIES)) {
    console.log(`📚 ${config.label} (${dir})`);
    const allPapers = new Map<string, any>();
    
    for (const q of config.queries) {
      const papers = await fetchPage(q, 20);
      papers.forEach(p => { if (p.title) allPapers.set(p.id, p); });
      await sleep(SLEEP_BETWEEN);
    }
    
    const merged = Array.from(allPapers.values());
    const count = insertBatch(merged, dir, config.label);
    grandTotal += count;
    console.log(`  ✓ ${count} 篇 (去重后)\n`);
  }

  const total = (db.prepare("SELECT COUNT(*) as c FROM papers").get() as any).c;
  const byDir = db.prepare("SELECT direction, direction_label, COUNT(*) as c FROM papers GROUP BY direction ORDER BY c DESC").all() as any[];
  
  console.log(`\n✅ 完成！共 ${total} 篇论文（新增 ${grandTotal}）\n`);
  byDir.forEach((d: any) => console.log(`  ${d.direction_label.padEnd(12)} (${d.direction.padEnd(13)}): ${d.c}`));
  db.close();
}

main().catch(console.error);
