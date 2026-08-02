"use client";

export type ClassificationResult = {
  primary_direction: string | null;
  secondary_directions: string[];
  confidence: number;
  reason_zh: string;
  evidence_terms: string[];
  new_direction: { label: string; query: string; reason_zh: string } | null;
  primary_label?: string | null;
  secondary_labels?: string[];
};

export default function ClassificationPanel({ result, provider, message, onCreateDirection, creating }: { result: ClassificationResult; provider?: string; message?: string; onCreateDirection?: () => void; creating?: boolean }) {
  return (
    <div className="mt-4 rounded-lg border border-sky-100 bg-sky-50/70 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold text-sky-900">DeepSeek 分类建议</h4>
        <span className="text-xs text-sky-700">{provider === "heuristic" ? "本地规则" : "DeepSeek"}</span>
      </div>
      <p className="mt-2 text-slate-800">系统推荐：<strong>{result.primary_label || result.primary_direction || "暂无合适的现有方向"}</strong> · 置信度 {Math.round(result.confidence * 100)}%</p>
      <p className="mt-1 leading-6 text-slate-700">{result.reason_zh}</p>
      {result.secondary_directions.length > 0 && <p className="mt-1 text-xs text-slate-600">也可归入：{(result.secondary_labels || result.secondary_directions).join("、")}</p>}
      {!result.primary_direction && result.new_direction && !result.new_direction.label.includes("待确认") && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="font-medium text-amber-900">建议新建研究方向：{result.new_direction.label}</p>
          <p className="mt-1 text-xs leading-5 text-amber-800">检索词：{result.new_direction.query}</p>
          <p className="mt-1 text-xs leading-5 text-amber-800">{result.new_direction.reason_zh}</p>
          {onCreateDirection && <button type="button" onClick={onCreateDirection} disabled={creating} className="mt-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">{creating ? "创建中..." : "创建这个研究方向"}</button>}
        </div>
      )}
      {message && <p className="mt-2 text-xs text-slate-500">{message}</p>}
    </div>
  );
}
