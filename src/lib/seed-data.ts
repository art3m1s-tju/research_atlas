/**
 * 种子数据：11 个研究方向 + 4 篇 demo 论文
 * 数据来源：AI-Research-Atlas-UI-Spec.md 中的 Demo JSON
 */

import { getDB } from "./db";

// ============ 研究方向数据 ============

export const SEED_DIRECTIONS = [
  { key: "all",      label: "全部方向",         color: "#d4a017", sortOrder: 0 },
  { key: "arch",     label: "基础架构与优化",     color: "#3b82f6", sortOrder: 1 },
  { key: "repr",     label: "表征学习与自监督",   color: "#14b8a6", sortOrder: 2 },
  { key: "gen",      label: "生成建模",          color: "#b45309", sortOrder: 3 },
  { key: "lm",       label: "语言模型",          color: "#8b5cf6", sortOrder: 4 },
  { key: "agent",    label: "推理、对齐与智能体", color: "#ef4444", sortOrder: 5 },
  { key: "vision",   label: "视觉感知",          color: "#2563eb", sortOrder: 6 },
  { key: "mm",       label: "多模态基础模型",     color: "#e11d48", sortOrder: 7 },
  { key: "rl",       label: "强化学习与决策",     color: "#65a30d", sortOrder: 8 },
  { key: "embodied", label: "具身智能与世界模型", color: "#f43f5e", sortOrder: 9 },
  { key: "ad3d",     label: "3D感知与自动驾驶",  color: "#6b7280", sortOrder: 10 },
] as const;

// ============ 论文数据 ============

export interface SeedPaper {
  slug: string;
  title: string;
  authors: string[];
  authorDisplay: string;
  authorCount: number;
  year: number;
  venue: string;
  venueType: "conference" | "journal" | "preprint";
  ccfRank: "A" | "B" | "C" | null;
  publicationChannel: string;
  reportSummary: string;
  modelTags: string[];
  citations: number | null; // null = unknown
  isFrontier: boolean;
  isCurrent: boolean;
  directions: string[]; // direction keys
}

export const SEED_PAPERS: SeedPaper[] = [
  {
    slug: "predictive-architecture",
    title: "Predictive Architecture",
    authors: [
      "Mahmoud Assran", "Quentin Duval", "Ishan Misra", "Piotr Bojanowski",
      "Armand Joulin", "Nicolas Ballas", "Michael Rabbat", "Joelle Pineau",
    ],
    authorDisplay: "Mahmoud Assran, Quentin Duval, Ishan Misra, Piotr Bojanowski 等 8 位作者",
    authorCount: 8,
    year: 2023,
    venue: "CVPR 2023",
    venueType: "conference",
    ccfRank: "A",
    publicationChannel: "CCF A",
    reportSummary:
      "论文报告：I-JEPA 不重建像素，也不让两次强增强保持不变；它从同一张图取一个大而分散的可见 context，用窄 ViT predictor 在位置 mask token 条件下预测多个较大 target 区域的 EMA target-encoder 表征。context 需要覆盖多样语义区域，target 需要足够大以包含高层语义，两者都需要足够分散以保证预测任务的信息量。训练时只用 L2 loss 在 latent space 预测，无需负样本、无需像素重建、无需数据增强的对称设计。",
    modelTags: ["ViT-L/16", "ViT-H/14", "ViT-H/16 448", "ViT-G/16"],
    citations: 1029,
    isFrontier: false,
    isCurrent: false,
    directions: ["repr"],
  },
  {
    slug: "dinov2",
    title: "DINOv2: Learning Robust Visual Features without Supervision",
    authors: [
      "Maxime Oquab", "Timothée Darcet", "Théo Moutakanni", "Huy V. Vo",
      "Marc Szafraniec", "Vasil Khalidov", "Camille Couprie", "Daniel Haziza",
      "Francisco Massa", "Armand Joulin", "Piotr Bojanowski",
      // ... 26 位作者
    ],
    authorDisplay: "Maxime Oquab, Timothée Darcet, Théo Moutakanni, Huy V. Vo 等 26 位作者",
    authorCount: 26,
    year: 2023,
    venue: "TMLR 2024",
    venueType: "journal",
    ccfRank: null,
    publicationChannel: "同行评议（CCF 未映射）",
    reportSummary:
      "论文报告：DINOv2 用经过视觉检索与去重构建的 LVD-142M，在无人工标签的 student-teacher 框架中联合优化图像级 DINO、遮挡 patch 级 iBOT 与 KoLeo 特征展开正则，训练 1.1B 参数 ViT-g/14 并蒸馏小模型；冻结特征用于下游时，在密集预测（深度估计、语义分割）和图像级检索上全面超越有监督 ImageNet 特征。",
    modelTags: ["DINOv2 ViT-S/14", "DINOv2 ViT-B/14", "DINOv2 ViT-L/14", "DINOv2 ViT-g/14"],
    citations: 9372,
    isFrontier: false,
    isCurrent: false,
    directions: ["repr"],
  },
  {
    slug: "dinov3",
    title: "DINOv3",
    authors: [
      "Oriane Siméoni", "Huy V. Vo", "Maximilian Seitzer", "Federico Baldassarre",
      "Timothée Darcet", "Camille Couprie", "Maxime Oquab", "Armand Joulin",
      "Piotr Bojanowski",
      // ... 26 位作者
    ],
    authorDisplay: "Oriane Siméoni, Huy V. Vo, Maximilian Seitzer, Federico Baldassarre 等 26 位作者",
    authorCount: 26,
    year: 2025,
    venue: "arXiv technical report",
    venueType: "preprint",
    ccfRank: null,
    publicationChannel: "unknown",
    reportSummary:
      "论文报告：DINOv3 把 DINO 的图像级自蒸馏、iBOT 的 masked-patch 聚类预测和 KoLeo regularization 扩展到 6.7B 参数、约 1.7B 图像：主训练用 2 个 256 全局 crop 与 8 个 112 局部 crop 学全局语义，却会在长训练中损失部分细节表现；通过 Gram anchoring 把 Gram 矩阵冻结为短训练的锚点，在保持语义的同时恢复空间精度，最终 ViT-7B/16 在 k-NN 分类、深度估计、语义分割等 20+ 基准上全面 SOTA。",
    modelTags: ["ViT-7B/16", "ViT-H+/16", "ViT-L/16", "ViT-B/16"],
    citations: null, // unknown
    isFrontier: true,
    isCurrent: true,
    directions: ["repr"],
  },
  {
    slug: "v-jepa-2",
    title: "V-JEPA 2: Self-Supervised Video Models Enable Understanding, Prediction and Planning",
    authors: [
      "Mahmoud Assran", "Adrien Bardes", "David Fan", "Quentin Garrido",
      "Reza Eshaghi", "Xinlei Chen", "Koustuv Ghosal", "Yann LeCun",
      "Michael Rabbat",
      // ... 29 位作者
    ],
    authorDisplay: "Mahmoud Assran, Adrien Bardes, David Fan, Quentin Garrido 等 29 位作者",
    authorCount: 29,
    year: 2025,
    venue: "arXiv technical report",
    venueType: "preprint",
    ccfRank: null,
    publicationChannel: "unknown",
    reportSummary:
      "论文报告：V-JEPA 2 先在 22M 视频/图像样本上训练一个不看动作的 1B ViT-g：删去视频时空 tubelet，只在抽象 latent space 预测被删部分的 EMA-teacher 表征；再完全冻结视觉表征，用不足 62 小时 DROID 轨迹数据训练动作条件模型，同时覆盖视觉理解、未来帧预测与机器人规划三大任务，在 28 个基准上取得 SOTA 或竞争力结果。",
    modelTags: ["ViT-L/16", "ViT-H/16", "ViT-g/16", "V-JEPA 2-AC"],
    citations: null, // unknown
    isFrontier: true,
    isCurrent: true,
    directions: ["repr", "embodied"],
  },
];

// ============ 种子数据写入函数 ============

/**
 * 将种子数据写入 SQLite
 */
export function seedDatabase(): void {
  const db = getDB();

  // 检查是否已有数据
  const existingCount = (db.prepare("SELECT COUNT(*) as count FROM directions").get() as { count: number }).count;
  if (existingCount > 0) {
    console.log("数据库已有数据，跳过种子数据写入。");
    return;
  }

  console.log("开始写入种子数据...");

  // 1. 写入研究方向
  const insertDirection = db.prepare(`
    INSERT INTO directions (key, label, color, sort_order)
    VALUES (@key, @label, @color, @sortOrder)
  `);

  const directionIds: Record<string, number> = {};
  for (const dir of SEED_DIRECTIONS) {
    const result = insertDirection.run(dir);
    directionIds[dir.key] = result.lastInsertRowid as number;
    console.log(`  ✓ 方向: ${dir.label} (${dir.key})`);
  }

  // 2. 写入论文
  const insertPaper = db.prepare(`
    INSERT INTO papers (
      slug, title, authors, author_display, author_count,
      year, venue, venue_type, ccf_rank, publication_channel,
      report_summary, model_tags, citations,
      is_frontier, is_current
    ) VALUES (
      @slug, @title, @authors, @authorDisplay, @authorCount,
      @year, @venue, @venueType, @ccfRank, @publicationChannel,
      @reportSummary, @modelTags, @citations,
      @isFrontier, @isCurrent
    )
  `);

  const insertPaperDirection = db.prepare(`
    INSERT INTO paper_directions (paper_id, direction_id)
    VALUES (@paperId, @directionId)
  `);

  // 默认用户偏好（全部订阅）
  const insertPreference = db.prepare(`
    INSERT OR IGNORE INTO user_preferences (direction_id, weight, subscribed)
    VALUES (@directionId, 1.0, 1)
  `);

  const seedAll = db.transaction(() => {
    for (const paper of SEED_PAPERS) {
      const result = insertPaper.run({
        slug: paper.slug,
        title: paper.title,
        authors: JSON.stringify(paper.authors),
        authorDisplay: paper.authorDisplay,
        authorCount: paper.authorCount,
        year: paper.year,
        venue: paper.venue,
        venueType: paper.venueType,
        ccfRank: paper.ccfRank,
        publicationChannel: paper.publicationChannel,
        reportSummary: paper.reportSummary,
        modelTags: JSON.stringify(paper.modelTags),
        citations: paper.citations,
        isFrontier: paper.isFrontier ? 1 : 0,
        isCurrent: paper.isCurrent ? 1 : 0,
      });

      const paperId = result.lastInsertRowid as number;

      // 写入论文-方向关联
      for (const dirKey of paper.directions) {
        const dirId = directionIds[dirKey];
        if (dirId) {
          insertPaperDirection.run({ paperId, directionId: dirId });
        }
      }

      console.log(`  ✓ 论文: ${paper.title}`);
    }

    // 为所有方向创建默认用户偏好
    for (const dir of SEED_DIRECTIONS) {
      if (dir.key !== "all") {
        insertPreference.run({ directionId: directionIds[dir.key] });
      }
    }
  });

  seedAll();

  // 验证
  const paperCount = (db.prepare("SELECT COUNT(*) as count FROM papers").get() as { count: number }).count;
  const dirCount = (db.prepare("SELECT COUNT(*) as count FROM directions").get() as { count: number }).count;
  console.log(`\n种子数据写入完成：${dirCount} 个方向，${paperCount} 篇论文。`);
}
