/**
 * 从 SQLite 数据库读取论文数据
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");

// 研究方向映射
const DIRECTION_MAP: Record<string, { key: string; label: string; color: string }> = {
  arch: { key: "arch", label: "基础架构与优化", color: "#3b82f6" },
  repr: { key: "repr", label: "表征学习与自监督", color: "#14b8a6" },
  gen: { key: "gen", label: "生成建模", color: "#b45309" },
  lm: { key: "lm", label: "语言模型", color: "#8b5cf6" },
  agent: { key: "agent", label: "推理、对齐与智能体", color: "#ef4444" },
  vision: { key: "vision", label: "视觉感知", color: "#2563eb" },
  mm: { key: "mm", label: "多模态基础模型", color: "#e11d48" },
  rl: { key: "rl", label: "强化学习与决策", color: "#65a30d" },
  embodied: { key: "embodied", label: "具身智能与世界模型", color: "#f43f5e" },
  ad3d: { key: "ad3d", label: "3D感知与自动驾驶", color: "#6b7280" },
};

interface DBPaper {
  id: string;
  title: string;
  reportSummary: string;
  year: number;
  venue: string;
  semanticScholarCitations: number;
  authors: string;
  direction: string;
  publicationChannel: string;
  isFrontier: boolean;
  isCurrent: boolean;
  modelTags: string[];
  badges: string[];
  directions: string[];
  directionLabel?: string;
  directionColor?: string;
}

function inferPublicationChannel(venue: string): string {
  if (!venue) return "arXiv 预印本";
  const topVenues = ["NeurIPS","ICML","ICLR","CVPR","ICCV","ECCV","ACL","EMNLP","NAACL","AAAI","ICRA","RSS"];
  for (const top of topVenues) {
    if (venue.toLowerCase().includes(top.toLowerCase())) return "CCF A";
  }
  return "同行评议";
}

export function getPapersFromDB(): DBPaper[] {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    
    const rows = db.prepare(`
      SELECT 
        openalex_id as id, title, abstract as reportSummary,
        year, venue, citations, authors, direction
      FROM papers ORDER BY citations DESC
    `).all() as any[];
    
    db.close();
    
    return rows.map(row => {
      const dirInfo = DIRECTION_MAP[row.direction];
      const authorsList = row.authors ? row.authors.split(", ") : [];
      const authorDisplay = authorsList.length > 4 
        ? `${authorsList.slice(0, 4).join(", ")} 等 ${authorsList.length} 位作者`
        : authorsList.join(", ");
      
      const currentYear = new Date().getFullYear();
      const isFrontier = row.year && currentYear - row.year <= 1;
      const isCurrent = (row.citations || 0) > 100;
      const badges: string[] = [];
      if (isFrontier) badges.push("前沿");
      if (isCurrent) badges.push("当前");
      
      const summary = row.reportSummary || "";
      const truncatedSummary = summary.length > 280 ? summary.substring(0, 280) + "..." : summary;
      
      return {
        id: row.id,
        title: row.title,
        reportSummary: truncatedSummary,
        year: row.year || currentYear,
        venue: row.venue || "arXiv",
        semanticScholarCitations: row.citations || 0,
        authors: authorDisplay,
        direction: row.direction,
        publicationChannel: inferPublicationChannel(row.venue),
        isFrontier,
        isCurrent,
        modelTags: [],
        badges,
        directions: [row.direction],
        directionLabel: dirInfo?.label,
        directionColor: dirInfo?.color,
      };
    });
  } catch (error) {
    console.error("DB read error:", error);
    return [];
  }
}

export function getDirectionsFromDB() {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    
    const counts = db.prepare(`
      SELECT direction, COUNT(*) as count FROM papers GROUP BY direction
    `).all() as { direction: string; count: number }[];
    
    db.close();
    
    const totalCount = counts.reduce((sum, c) => sum + c.count, 0);
    const countMap = Object.fromEntries(counts.map(c => [c.direction, c.count]));
    
    return [
      { key: "all", label: "全部方向", count: totalCount, color: "#d4a017" },
      ...Object.values(DIRECTION_MAP).map(d => ({
        ...d,
        count: countMap[d.key] || 0,
      })),
    ];
  } catch (error) {
    return [
      { key: "all", label: "全部方向", count: 0, color: "#d4a017" },
    ];
  }
}
