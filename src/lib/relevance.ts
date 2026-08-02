const BUILTIN_DOMAIN_TERMS: Record<string, string[]> = {
  e2e: ["autonomous driving", "self-driving", "autonomous vehicle", "driverless", "end-to-end driving", "uniad", "sparsedrive", "carla", "nuscenes", "waymo"],
  planning: ["autonomous driving", "self-driving", "motion planning", "trajectory planning", "path planning", "model predictive control", "vehicle trajectory", "robot motion planning"],
  world_model: ["driving world model", "autonomous driving", "world model", "video prediction", "embodied ai", "robotics simulation", "carla"],
  llm_driving: ["autonomous driving", "self-driving", "vehicle", "driving", "vision-language", "large language model", "llm", "embodied ai", "robotics"],
  control: ["vehicle control", "autonomous driving", "path tracking", "trajectory tracking", "model predictive control", "lane keeping", "steering control", "robot control"],
  perception: ["autonomous driving", "self-driving", "3d object detection", "bird's-eye view", "bev", "lidar", "camera perception", "autonomous vehicle", "nuscenes"],
  prediction: ["autonomous driving", "self-driving", "trajectory prediction", "motion forecasting", "vehicle trajectory", "pedestrian trajectory", "autonomous vehicle"],
  rl_driving: ["autonomous driving", "self-driving", "reinforcement learning driving", "autonomous vehicle", "robotics", "vehicle control"],
  racing: ["autonomous racing", "racing car", "driverless", "formula student", "vehicle dynamics", "high-speed autonomous", "racing line"],
  safety: ["autonomous driving", "self-driving safety", "vehicle safety", "safe autonomous driving", "autonomous vehicle", "v2x", "uncertainty", "verification"],
};

const CUSTOM_DOMAIN_HINTS = [
  "自动驾驶", "无人驾驶", "车辆", "汽车", "驾驶", "robot", "robotics", "autonomous", "driving", "vehicle", "self-driving",
];

const AUTONOMY_PATTERNS = [
  /autonomous.{0,40}(driving|vehicle|car|urban|system)/,
  /(driving|vehicle|car|urban|system).{0,40}autonomous/,
  /self[- ]driving/,
  /automated.{0,30}(driving|vehicle)/,
  /driverless/,
  /intelligent.{0,20}vehicles?/,
  /road.{0,20}vehicles?/,
  /vehicles?.{0,40}(control|planning|trajectory|motion|dynamics|perception|detection|forecast|prediction|tracking|steering)/,
  /(control|planning|trajectory|motion|dynamics|perception|detection|forecast|prediction|tracking|steering).{0,40}vehicles?/,
  /carla|nuscenes|waymo|lidar|bird.?s[- ]eye|\bbev\b|\bv2x\b|\bslam\b/,
];

const ROBOTICS_PATTERNS = [/robotics?/, /embodied ai/, /quadrotor/, /drone/, /\buav\b/];
const RACING_PATTERNS = [/autonomous racing/, /racing car/, /driverless/, /formula student/, /vehicle dynamics/, /high[- ]speed autonomous/, /racing line/];

function containsTerm(text: string, term: string) {
  return text.includes(term);
}

export function isLikelyRelevant(
  paper: { title: string; abstract?: string | null; venue?: string | null },
  directionKey: string,
  directionLabel?: string,
  directionQuery?: string,
) {
  const text = [paper.title, paper.abstract, paper.venue].filter(Boolean).join(" ").toLowerCase();
  const terms = BUILTIN_DOMAIN_TERMS[directionKey];
  if (terms) {
    if (terms.some((term) => containsTerm(text, term))) return true;
    const patterns = directionKey === "racing"
      ? RACING_PATTERNS
      : [
          ...(directionKey === "e2e" || directionKey === "perception" || directionKey === "prediction" ? [] : ROBOTICS_PATTERNS),
          ...AUTONOMY_PATTERNS,
        ];
    return patterns.some((pattern) => pattern.test(text));
  }

  const directionText = `${directionLabel || ""} ${directionQuery || ""}`.toLowerCase();
  if (!CUSTOM_DOMAIN_HINTS.some((hint) => directionText.includes(hint))) return true;
  return [
    ...CUSTOM_DOMAIN_HINTS,
    "hallucination", "幻觉", "uncertainty", "不确定性", "safety", "安全", "control", "控制", "perception", "感知",
  ].some((term) => containsTerm(text, term)) || AUTONOMY_PATTERNS.some((pattern) => pattern.test(text));
}

export function relevanceTerms(directionKey: string) {
  return BUILTIN_DOMAIN_TERMS[directionKey] || [];
}
