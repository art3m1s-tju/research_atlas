export const directions = [
  { key: "all", label: "全部方向", count: 91, color: "#d4a017" },
  { key: "arch", label: "基础架构与优化", count: 9, color: "#3b82f6" },
  { key: "repr", label: "表征学习与自监督", count: 9, color: "#14b8a6" },
  { key: "gen", label: "生成建模", count: 12, color: "#b45309" },
  { key: "lm", label: "语言模型", count: 7, color: "#8b5cf6" },
  { key: "agent", label: "推理、对齐与智能体", count: 9, color: "#ef4444" },
  { key: "vision", label: "视觉感知", count: 8, color: "#2563eb" },
  { key: "mm", label: "多模态基础模型", count: 8, color: "#e11d48" },
  { key: "rl", label: "强化学习与决策", count: 9, color: "#65a30d" },
  { key: "embodied", label: "具身智能与世界模型", count: 10, color: "#f43f5e" },
  { key: "ad3d", label: "3D感知与自动驾驶", count: 10, color: "#6b7280" }
];

interface PaperData {
  id: string;
  title: string;
  authors: string;
  year: number;
  venue: string;
  directions: string[];
  reportSummary: string;
  modelTags: string[];
  publicationChannel: string;
  semanticScholarCitations: number | "unknown";
  badges: string[];
  isFrontier: boolean;
  isCurrent: boolean;
  directionLabel?: string;
  directionColor?: string;
}

export const papers: PaperData[] = [
  {
    id: "predictive-architecture",
    title: "Predictive Architecture",
    authors: "Mahmoud Assran, Quentin Duval, Ishan Misra, Piotr Bojanowski 等 8 位作者",
    year: 2023,
    venue: "CVPR 2023",
    directions: ["repr"],
    reportSummary: "I-JEPA 不重建像素，也不让两次强增强保持不变；它从同一张图取一个大而分散的可见 context，用窄 ViT predictor 在位置 mask token 条件下预测多个较大 target 区域的 EMA target-encoder 表征。",
    modelTags: ["ViT-L/16", "ViT-H/14", "ViT-H/16 448", "ViT-G/16"],
    publicationChannel: "CCF A",
    semanticScholarCitations: 1029,
    badges: [],
    isFrontier: false,
    isCurrent: false
  },
  {
    id: "dinov2",
    title: "DINOv2: Learning Robust Visual Features without Supervision",
    authors: "Maxime Oquab, Timothée Darcet, Théo Moutakanni, Huy V. Vo 等 26 位作者",
    year: 2023,
    venue: "TMLR 2024",
    directions: ["repr"],
    reportSummary: "DINOv2 用经过视觉检索与去重构建的 LVD-142M，在无人工标签的 student-teacher 框架中联合优化图像级 DINO、遮挡 patch 级 iBOT 与 KoLeo 特征展开正则，训练 1.1B 参数 ViT-g/14 并蒸馏小模型；冻结特征用于下游。",
    modelTags: ["DINOv2 ViT-S/14", "DINOv2 ViT-B/14", "DINOv2 ViT-L/14", "DINOv2 ViT-g/14"],
    publicationChannel: "同行评议（CCF 未映射）",
    semanticScholarCitations: 9372,
    badges: [],
    isFrontier: false,
    isCurrent: false
  },
  {
    id: "dinov3",
    title: "DINOv3",
    authors: "Oriane Siméoni, Huy V. Vo, Maximilian Seitzer, Federico Baldassarre 等 26 位作者",
    year: 2025,
    venue: "arXiv technical report",
    directions: ["repr"],
    reportSummary: "DINOv3 把 DINO 的图像级自蒸馏、iBOT 的 masked-patch 聚类预测和 KoLeo regularization 扩展到 6.7B 参数、约 1.7B 图像：主训练用 2 个 256 全局 crop 与 8 个 112 局部 crop 学全局语义，却会在长训练中损失部分细节表现。",
    modelTags: ["ViT-7B/16", "ViT-H+/16", "ViT-L/16", "ViT-B/16"],
    publicationChannel: "unknown",
    semanticScholarCitations: "unknown",
    badges: ["前沿", "当前"],
    isFrontier: true,
    isCurrent: true,
    directionLabel: "表征学习与自监督",
    directionColor: "#14b8a6"
  },
  {
    id: "v-jepa-2",
    title: "V-JEPA 2: Self-Supervised Video Models Enable Understanding, Prediction and Planning",
    authors: "Mahmoud Assran, Adrien Bardes, David Fan, Quentin Garrido 等 29 位作者",
    year: 2025,
    venue: "arXiv technical report",
    directions: ["repr", "embodied"],
    reportSummary: "V-JEPA 2 先在 22M 视频/图像样本上训练一个不看动作的 1B ViT-g：删去视频时空 tubelet，只在抽象 latent space 预测被删部分的 EMA-teacher 表征；再完全冻结视觉表征，用不足 62 小时 DROID 轨迹数据训练动作条件模型。",
    modelTags: ["ViT-L/16", "ViT-H/16", "ViT-g/16", "V-JEPA 2-AC"],
    publicationChannel: "unknown",
    semanticScholarCitations: "unknown",
    badges: ["前沿", "当前"],
    isFrontier: true,
    isCurrent: true,
    directionLabel: "表征学习与自监督",
    directionColor: "#14b8a6"
  }
];
