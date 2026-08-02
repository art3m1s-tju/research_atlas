import { createHash } from "node:crypto";
import { BUILTIN_DIRECTION_LABELS } from "@/lib/research-ranking";

export type ClassificationDirection = { key: string; label: string; query?: string };

export type PaperClassification = {
  primary_direction: string | null;
  secondary_directions: string[];
  confidence: number;
  reason_zh: string;
  evidence_terms: string[];
  new_direction: { label: string; query: string; reason_zh: string } | null;
};

export function classificationSourceHash(paper: { title: string; abstract?: string | null; venue?: string | null; year?: number | null }) {
  return createHash("sha256").update([paper.title, paper.abstract || "", paper.venue || "", paper.year || ""].join("\n")).digest("hex");
}

export function classificationSystemPrompt(directions: ClassificationDirection[]) {
  const directionList = directions.map((direction) => `- ${direction.key}: ${direction.label}${direction.query ? `（检索词：${direction.query}）` : ""}`).join("\n");
  return `你是 AI Research Atlas 的高级科研文献分类员，服务对象是做端到端自动驾驶、规划控制、世界模型和大模型驾驶的研究者。

你的任务是：仅根据论文标题、摘要、发表渠道和年份，把论文归入最合适的现有研究方向。必须优先复用现有方向，不要因为关键词偶然出现就硬分类。尤其要区分：端到端驾驶（直接从感知到规划/控制）、运动规划与控制、驾驶世界模型、大模型+驾驶、车辆控制、BEV感知、轨迹预测、强化学习驾驶、自动驾驶竞赛、安全验证。

现有方向（primary_direction 和 secondary_directions 只能使用下面的 key，不能自行改写）：
${directionList}

如果现有方向都不合适，primary_direction 返回 null，并填写 new_direction，给出一个简洁、可作为文件夹名称的中文方向名、3 个以上英文检索词和原因。不要为了凑分类而创造方向，也不要把医学、金融、纯 NLP 等无关论文归入自动驾驶方向。

只输出合法 JSON，不要 Markdown 代码围栏，不要编造会议、数据集、引用量或实验结果。字段必须为：
{
  "primary_direction": "现有方向 key 或 null",
  "secondary_directions": ["现有方向 key"],
  "confidence": 0.0,
  "reason_zh": "不超过80字的中文分类理由",
  "evidence_terms": ["支持判断的标题/摘要术语，最多5个"],
  "new_direction": {"label":"中文方向名","query":"英文检索词1 OR 英文检索词2 OR 英文检索词3","reason_zh":"为什么现有方向不够"} 或 null
}`;
}

export function buildClassificationPrompt(paper: { title: string; abstract?: string | null; authors?: string | null; venue?: string | null; year?: number | null }, directions: ClassificationDirection[]) {
  return {
    system: classificationSystemPrompt(directions),
    user: `请分类下面这篇论文。摘要没有提供的信息不要推断。\n\n标题：${paper.title}\n作者：${paper.authors || "未提供"}\n年份：${paper.year || "未提供"}\n发表渠道：${paper.venue || "未提供"}\n摘要：${paper.abstract || "未提供"}`,
  };
}

export function parseClassificationJson(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned) as unknown; } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    throw new Error("DeepSeek 返回的分类结果不是合法 JSON");
  }
}

export function normalizeClassification(value: unknown, directions: ClassificationDirection[]): PaperClassification {
  const data = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const validKeys = new Set(directions.map((direction) => direction.key));
  const labelToKey = new Map(directions.map((direction) => [direction.label, direction.key]));
  const toKey = (item: unknown) => {
    if (typeof item !== "string") return null;
    return validKeys.has(item) ? item : labelToKey.get(item) || null;
  };
  const primary = toKey(data.primary_direction);
  const secondary = Array.isArray(data.secondary_directions)
    ? [...new Set(data.secondary_directions.map(toKey).filter((item): item is string => Boolean(item)).filter((item) => item !== primary))].slice(0, 3)
    : [];
  const suggestion = data.new_direction && typeof data.new_direction === "object" ? data.new_direction as Record<string, unknown> : null;
  const newDirection = suggestion && typeof suggestion.label === "string" && typeof suggestion.query === "string"
    ? { label: suggestion.label.trim().slice(0, 40), query: suggestion.query.trim().slice(0, 160), reason_zh: typeof suggestion.reason_zh === "string" ? suggestion.reason_zh.trim().slice(0, 160) : "现有方向覆盖不足" }
    : null;
  return {
    primary_direction: primary,
    secondary_directions: secondary,
    confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)),
    reason_zh: typeof data.reason_zh === "string" ? data.reason_zh.trim().slice(0, 200) : "分类依据不足",
    evidence_terms: Array.isArray(data.evidence_terms) ? data.evidence_terms.filter((item): item is string => typeof item === "string").slice(0, 5) : [],
    new_direction: newDirection,
  };
}

export function heuristicClassification(paper: { title: string; abstract?: string | null; venue?: string | null }, directions: ClassificationDirection[]): PaperClassification {
  const text = `${paper.title} ${paper.abstract || ""} ${paper.venue || ""}`.toLowerCase();
  const patterns: Array<[string, RegExp]> = [
    ["e2e", /end[- ]to[- ]end|unified driving|planning-oriented autonomous driving|directly.*(control|trajectory)/i],
    ["planning", /motion planning|trajectory planning|path planning|model predictive control/i],
    ["world_model", /world model|video prediction|predictive model|latent dynamics/i],
    ["llm_driving", /large language model|\bllm\b|vision-language|multimodal language/i],
    ["control", /vehicle control|path tracking|trajectory tracking|steering control/i],
    ["perception", /bird.?s[- ]eye|\bbev\b|3d object detection|lidar perception/i],
    ["prediction", /trajectory prediction|motion forecasting|behavior prediction/i],
    ["rl_driving", /reinforcement learning|deep rl|policy optimization/i],
    ["racing", /autonomous racing|racing car|formula student/i],
    ["safety", /safety verification|safe autonomous|uncertainty|hallucination|幻觉|安全/i],
  ];
  const found = patterns.filter(([, pattern]) => pattern.test(text)).map(([key]) => key).filter((key) => directions.some((direction) => direction.key === key));
  const primary = found[0] || null;
  const labels = new Map(directions.map((direction) => [direction.key, direction.label]));
  return {
    primary_direction: primary,
    secondary_directions: found.slice(1, 3),
    confidence: primary ? 0.42 : 0,
    reason_zh: primary ? `本地规则识别到${labels.get(primary) || primary}相关术语；建议配置 DeepSeek 做更细分类。` : "本地规则未识别到明确的现有方向。",
    evidence_terms: found.slice(0, 5),
    new_direction: primary ? null : { label: "待确认的新研究方向", query: "请配置 DeepSeek 生成检索词", reason_zh: "本地规则无法可靠判断，暂不自动创建方向。" },
  };
}

export function defaultDirections(custom: ClassificationDirection[] = []) {
  return [...Object.entries(BUILTIN_DIRECTION_LABELS).map(([key, label]) => ({ key, label })), ...custom];
}
