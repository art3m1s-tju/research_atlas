// AI Research Atlas 核心类型定义

/**
 * 研究方向枚举
 */
export type ResearchDirection =
  | "全部方向"
  | "基础架构与优化"
  | "表征学习与自监督"
  | "生成建模"
  | "语言模型"
  | "推理、对齐与智能体"
  | "视觉感知"
  | "多模态基础模型"
  | "强化学习与决策"
  | "具身智能与世界模型"
  | "3D感知与自动驾驶";

/**
 * 研究方向元数据
 */
export interface Direction {
  id?: number;
  key: string;
  label: ResearchDirection;
  color: string;
  count?: number;
  sortOrder?: number;
}

/**
 * 论文卡片数据（用于展示）
 */
export interface PaperCard {
  id: string;
  slug: string;
  title: string;
  authors: string[];
  authorDisplay: string;
  authorCount: number;
  year: number | string;
  venue: string;
  venueType?: "conference" | "journal" | "preprint";
  ccfRank?: "A" | "B" | "C" | null;
  directions: ResearchDirection[];
  isFrontier?: boolean;
  isCurrent?: boolean;
  reportSummary: string;
  modelTags: string[];
  publicationChannel: string;
  publicationChannelType?: "ccf" | "peer_review" | "unknown";
  semanticScholarCitations?: number | "unknown";
  actions: {
    canOpenWebReader: boolean;
    canOpenEvidenceCard: boolean;
    canOpenDocument: boolean;
  };
  externalLinks?: {
    webReaderUrl?: string;
    evidenceCardUrl?: string;
    documentUrl?: string;
    obsidianUrl?: string;
  };
  // 数据库内部字段
  abstract?: string;
  arxivId?: string;
  semanticScholarId?: string;
  pdfUrl?: string;
  citationsUpdatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 用户偏好配置
 */
export interface UserPreferences {
  id?: number;
  directionId: number;
  directionKey?: string;
  directionLabel?: string;
  weight: number; // 0.0 ~ 1.0
  subscribed: boolean;
  updatedAt: string;
}

/**
 * 论文推荐输出
 */
export interface RecommendationResult {
  papers: PaperCard[];
  reasoning?: string;
}

/**
 * 论文列表查询参数
 */
export interface PaperListQuery {
  directionKey?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: "citations" | "year" | "relevance";
}

/**
 * 论文列表响应
 */
export interface PaperListResponse {
  papers: PaperCard[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * 数据库行类型（内部使用）
 */
export interface DBPaper {
  id: number;
  slug: string;
  title: string;
  authors: string; // JSON string
  author_display: string;
  author_count: number;
  year: number | null;
  venue: string | null;
  venue_type: string | null;
  ccf_rank: string | null;
  publication_channel: string | null;
  report_summary: string | null;
  model_tags: string; // JSON string
  citations: number | null;
  citations_updated_at: string | null;
  is_frontier: number;
  is_current: number;
  abstract: string | null;
  arxiv_id: string | null;
  semantic_scholar_id: string | null;
  pdf_url: string | null;
  web_reader_url: string | null;
  evidence_url: string | null;
  obsidian_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBDirection {
  id: number;
  key: string;
  label: string;
  color: string;
  sort_order: number;
}

export interface DBUserPreference {
  id: number;
  direction_id: number;
  weight: number;
  subscribed: number;
  updated_at: string;
}
