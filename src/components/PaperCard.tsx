interface Paper {
  id: string;
  title: string;
  authors: string;
  year: number;
  venue: string;
  citations: number;
  abstract: string;
  direction: string;
  doi: string | null;
  pdfUrl: string | null;
  directionLabel?: string;
  directionColor?: string;
  sources?: string[];
  sourceUrls?: Record<string, string>;
}

const DIRECTION_LABELS: Record<string, { label: string; color: string }> = {
  e2e: { label: "端到端自动驾驶", color: "#3b82f6" },
  planning: { label: "运动规划与控制", color: "#14b8a6" },
  world_model: { label: "驾驶世界模型", color: "#b45309" },
  llm_driving: { label: "大模型+驾驶", color: "#8b5cf6" },
  control: { label: "车辆控制", color: "#ef4444" },
  perception: { label: "BEV感知", color: "#2563eb" },
  prediction: { label: "轨迹预测", color: "#e11d48" },
  rl_driving: { label: "强化学习驾驶", color: "#65a30d" },
  racing: { label: "自动驾驶竞赛", color: "#f43f5e" },
  safety: { label: "安全验证", color: "#6b7280" },
};

export default function PaperCard({ paper }: { paper: Paper }) {
  const dir = paper.directionLabel
    ? { label: paper.directionLabel, color: paper.directionColor || "#64748b" }
    : DIRECTION_LABELS[paper.direction];
  const isRecent = paper.year && new Date().getFullYear() - paper.year <= 1;
  const isHot = paper.citations > 100;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-2 mb-3">
        {dir && (
          <span
            className="px-2 py-1 rounded-full text-xs font-medium"
            style={{ backgroundColor: dir.color + "20", color: dir.color }}
          >
            {dir.label}
          </span>
        )}
        {isRecent && (
          <span className="px-2 py-1 bg-green-50 text-green-700 text-xs rounded-full font-medium">
            前沿
          </span>
        )}
        {isHot && (
          <span className="px-2 py-1 bg-orange-50 text-orange-700 text-xs rounded-full font-medium">
            高引
          </span>
        )}
      </div>

      <h3 className="text-lg font-bold text-gray-900 mb-2 line-clamp-2">
        {paper.title}
      </h3>

      <p className="text-sm text-gray-600 mb-2 line-clamp-2">{paper.authors}</p>

      <div className="flex items-center gap-2 text-sm text-gray-500 mb-3">
        <span>{paper.venue}</span>
        {paper.venue && <span>•</span>}
        <span>{paper.year}</span>
      </div>

      {paper.sources && paper.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {paper.sources.map((source) => (
            <span key={source} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              {source}
            </span>
          ))}
        </div>
      )}

      {paper.abstract && (
        <p className="text-sm text-gray-700 mb-4 line-clamp-3 leading-relaxed">
          {paper.abstract}
        </p>
      )}

      <div className="flex items-center justify-between pt-4 border-t border-gray-100">
        <div className="text-sm text-gray-500">
          引用: <span className="font-medium text-gray-700">
            {paper.citations > 0 ? paper.citations.toLocaleString() : "暂无数据"}
          </span>
        </div>
        <div className="flex gap-2">
          {paper.pdfUrl && (
            <a
              href={paper.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
            >
              PDF
            </a>
          )}
          {paper.doi && (
            <a
              href={paper.doi}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors"
            >
              DOI
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
