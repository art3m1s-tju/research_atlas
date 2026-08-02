import Database from "better-sqlite3";

const OPENALEX_API = "https://api.openalex.org/works";

// 使用 filter 而非全文搜索，更精准
const DIRECTION_CONFIGS: Record<string, { filter: string; label: string }> = {
  e2e: {
    label: "端到端自动驾驶",
    filter: "title.search:end-to-end autonomous driving OR title.search:imitation learning driving OR title.search:behavior cloning driving OR title.search:UniAD OR title.search:VAD autonomous OR title.search:SparseDrive"
  },
  planning: {
    label: "运动规划",
    filter: "title.search:motion planning autonomous OR title.search:trajectory planning vehicle OR title.search:path planning robot OR title.search:motion planning navigation"
  },
  world_model: {
    label: "世界模型",
    filter: "title.search:world model driving OR title.search:world model simulation OR title.search:video generation driving OR title.search:driving simulator learning OR title.search:DriveDreamer OR title.search:GenAD OR title.search:GAIA"
  },
  llm_driving: {
    label: "大模型驾驶",
    filter: "title.search:large language model driving OR title.search:LLM autonomous OR title.search:vision language model driving OR title.search:multimodal driving OR title.search:GPT driving OR title.search:language model vehicle"
  },
  control: {
    label: "规划与控制",
    filter: "title.search:model predictive control vehicle OR title.search:trajectory tracking autonomous OR title.search:lateral control vehicle OR title.search:longitudinal control autonomous OR title.search:adaptive cruise control"
  },
  perception: {
    label: "BEV 感知",
    filter: "title.search:BEV perception OR title.search:bird eye view detection OR title.search:3D object detection autonomous OR title.search:multi-camera perception OR title.search:point cloud 3D detection"
  },
  prediction: {
    label: "轨迹预测",
    filter: "title.search:trajectory prediction vehicle OR title.search:motion forecasting autonomous OR title.search:pedestrian prediction OR title.search:interaction aware prediction"
  },
  rl_driving: {
    label: "强化学习驾驶",
    filter: "title.search:reinforcement learning driving OR title.search:reinforcement learning autonomous vehicle OR title.search:deep RL driving"
  },
  racing: {
    label: "自动驾驶竞赛",
    filter: "title.search:autonomous racing OR title.search:racing car control OR title.search:Formula Student driverless OR title.search:high speed vehicle control OR title.search:racing line optimization OR title.search:autonomous race OR title.search:motorsport autonomous OR title.search:high speed autonomous OR title.search:vehicle dynamics control racing OR title.search:minimum time racing"
  },
  safety: {
    label: "安全与验证",
    filter: "title.search:autonomous driving safety OR title.search:autonomous vehicle verification OR title.search:safety critical autonomous OR title.search:adversarial attack driving"
  }
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOpenAlex(filter: string, perPage = 25, sort = "cited_by_count:desc"): Promise<any[]> {
  const params = new URLSearchParams({
    filter,
    per_page: String(perPage),
    sort,
    select: "id,title,authorships,publication_year,primary_location,cited_by_count,abstract_inverted_index,doi,locations",
    mailto: "ai-research-atlas@example.com"
  });
  const res = await fetch(`${OPENALEX_API}?${params}`);
  if (!res.ok) { console.error(`  ❌ ${res.status}: ${res.statusText}`); return []; }
  const data = await res.json();
  return data.results || [];
}

function extractAbstract(inv: any): string {
  if (!inv) return "";
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions as number[]) words.push([pos, word]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(w => w[1]).join(" ").substring(0, 600);
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
    const arxivId = paper.doi.split("arxiv/")[1];
    if (arxivId) return `https://arxiv.org/pdf/${arxivId}.pdf`;
  }
  return null;
}

async function main() {
  const dbPath = "./data/atlas.db";
  
  // 清空重建
  const db = new Database(dbPath);
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
    )
  `);

  console.log("🚀 开始从 OpenAlex 拉取论文数据...\n");

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO papers 
    (openalex_id, title, abstract, year, venue, citations, authors, doi, pdf_url, direction, direction_label, publication_channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((papers: any[], dir: string, label: string) => {
    let count = 0;
    for (const p of papers) {
      if (!p.title) continue; // 跳过无标题论文
      const venue = p.primary_location?.source?.display_name || "";
      const authors = (p.authorships || []).map((a: any) => a.author?.display_name).join(", ");
      const channel = venue.includes("arXiv") ? "arXiv 预印本" : 
                      venue.toUpperCase().match(/CVPR|ICCV|ECCV|NEURIPS|ICML|ICLR|AAAI/) ? "CCF A" : "同行评议";
      insertStmt.run(
        p.id, p.title, extractAbstract(p.abstract_inverted_index),
        p.publication_year, venue, p.cited_by_count || 0,
        authors, p.doi, extractPdfUrl(p),
        dir, label, channel
      );
      count++;
    }
    return count;
  });

  for (const [dir, config] of Object.entries(DIRECTION_CONFIGS)) {
    console.log(`📚 ${config.label} (${dir})`);
    
    // 按引用量排序
    const byCitations = await fetchOpenAlex(config.filter, 25, "cited_by_count:desc");
    await sleep(200);
    
    // 按时间排序（最新论文）
    const byDate = await fetchOpenAlex(config.filter, 25, "publication_date:desc");
    await sleep(200);
    
    // 合并去重
    const allPapers = new Map();
    [...byCitations, ...byDate].forEach(p => allPapers.set(p.id, p));
    const merged = Array.from(allPapers.values());
    
    const count = insertMany(merged, dir, config.label);
    console.log(`  ✓ ${count} 篇论文\n`);
  }

  // 统计
  const total = db.prepare("SELECT COUNT(*) as c FROM papers").get() as any;
  const byDir = db.prepare("SELECT direction, direction_label, COUNT(*) as c FROM papers GROUP BY direction ORDER BY c DESC").all();
  
  console.log(`\n✅ 同步完成！共 ${total.c} 篇论文\n`);
  console.log("方向分布:");
  byDir.forEach((d: any) => console.log(`  ${d.direction_label.padEnd(12)} (${d.direction.padEnd(13)}): ${d.c}`));

  db.close();
}

main().catch(console.error);
