import Database from "better-sqlite3";
import { isLikelyRelevant } from "../src/lib/relevance";
import { getClassicSeed } from "../src/lib/research-ranking";

const BUILTIN_LABELS: Record<string, string> = {
  e2e: "端到端自动驾驶",
  planning: "运动规划与控制",
  world_model: "驾驶世界模型",
  llm_driving: "大模型+驾驶",
  control: "车辆控制",
  perception: "BEV感知",
  prediction: "轨迹预测",
  rl_driving: "强化学习驾驶",
  racing: "自动驾驶竞赛",
  safety: "安全验证",
};

const db = new Database(process.env.DATABASE_PATH || "./data/atlas.db");
const columns = new Set(
  (db.prepare("PRAGMA table_info(papers)").all() as { name: string }[]).map((column) => column.name),
);
if (!columns.has("is_relevant")) db.exec("ALTER TABLE papers ADD COLUMN is_relevant INTEGER NOT NULL DEFAULT 1");
db.exec(`
  CREATE TABLE IF NOT EXISTS paper_directions (
    paper_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    direction_label TEXT NOT NULL,
    is_relevant INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (paper_id, direction)
  )
`);
const directionColumns = new Set(
  (db.prepare("PRAGMA table_info(paper_directions)").all() as { name: string }[]).map((column) => column.name),
);
if (!directionColumns.has("is_relevant")) db.exec("ALTER TABLE paper_directions ADD COLUMN is_relevant INTEGER NOT NULL DEFAULT 1");
db.exec(`
  INSERT OR IGNORE INTO paper_directions (paper_id, direction, direction_label)
  SELECT id, direction, COALESCE(direction_label, direction)
  FROM papers
  WHERE direction IS NOT NULL AND direction != ''
`);

const customDirections = db.prepare("SELECT key, label, query FROM custom_directions").all() as {
  key: string;
  label: string;
  query: string;
}[];
const directionMap = new Map([
  ...Object.entries(BUILTIN_LABELS).map(([key, label]) => [key, { label, query: label }] as const),
  ...customDirections.map((direction) => [direction.key, direction] as const),
]);

const papers = db.prepare("SELECT id, title, abstract, venue, direction, is_classic FROM papers").all() as {
  id: number;
  title: string;
  abstract: string | null;
  venue: string | null;
  direction: string;
  is_classic: number | null;
}[];
const update = db.prepare("UPDATE papers SET is_relevant = ? WHERE id = ?");
const updateDirection = db.prepare("UPDATE paper_directions SET is_relevant = ? WHERE paper_id = ? AND direction = ?");
const counts = new Map<string, { visible: number; hidden: number }>();
let hidden = 0;

for (const paper of papers) {
  const linkedDirections = db.prepare(
    "SELECT direction, direction_label FROM paper_directions WHERE paper_id = ?"
  ).all(paper.id) as { direction: string; direction_label: string }[];
  const candidates = linkedDirections.length ? linkedDirections : [{ direction: paper.direction, direction_label: paper.direction }];
  const isClassic = paper.is_classic === 1 || Boolean(getClassicSeed(paper.title));
  const relevantDirections = isClassic ? candidates : candidates.filter((linked) => {
    const direction = directionMap.get(linked.direction);
    return direction
      ? isLikelyRelevant(paper, linked.direction, direction.label, direction.query)
      : true;
  });
  for (const linked of candidates) {
    updateDirection.run(relevantDirections.some((item) => item.direction === linked.direction) ? 1 : 0, paper.id, linked.direction);
  }
  const relevant = relevantDirections.length > 0;
  update.run(relevant ? 1 : 0, paper.id);
  const count = counts.get(paper.direction) || { visible: 0, hidden: 0 };
  if (relevant) count.visible += 1;
  else { count.hidden += 1; hidden += 1; }
  counts.set(paper.direction, count);
}

for (const [direction, count] of counts) {
  console.log(`${direction}: visible=${count.visible}, hidden=${count.hidden}`);
}
console.log(`完成：隐藏 ${hidden} 篇明显不相关论文（未删除，可通过数据库恢复）`);
db.close();
