import * as React from "react";
import { Button } from "@/components/ui/button";

interface Direction {
  key: string;
  label: string;
  count: number;
  color: string;
}

interface SidebarProps {
  directions: Direction[];
  selected: string;
  onSelect: (key: string) => void;
  onSync: () => void;
  syncing?: boolean;
  syncStatus?: {
    state: "idle" | "running" | "completed" | "failed";
    phase: string;
    message: string;
    currentDirection: string | null;
    completedDirections: number;
    totalDirections: number;
    inserted: number;
    updated: number;
    unchanged: number;
    errors: string[];
  } | null;
  onAddDirection: (label: string, query: string) => Promise<void>;
}

export default function Sidebar({
  directions,
  selected,
  onSelect,
  onSync,
  syncing,
  syncStatus,
  onAddDirection,
}: SidebarProps) {
  const [showForm, setShowForm] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submitDirection(event: React.FormEvent) {
    event.preventDefault();
    setAdding(true);
    setError("");
    try {
      await onAddDirection(label, query);
      setLabel("");
      setQuery("");
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增方向失败");
    } finally {
      setAdding(false);
    }
  }

  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col h-screen sticky top-0">
      <div className="px-6 py-5 border-b border-gray-200">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900">研究方向</h2>
          <button
            type="button"
            onClick={() => setShowForm((open) => !open)}
            className="text-xs font-medium text-blue-600 hover:text-blue-800"
          >
            {showForm ? "收起" : "＋ 新增"}
          </button>
        </div>
        {showForm && (
          <form onSubmit={submitDirection} className="mt-4 space-y-2">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="方向名称，如：自动驾驶幻觉控制"
              className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              disabled={adding}
            />
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="检索词，如：autonomous driving hallucination control"
              rows={3}
              className="w-full resize-none rounded-md border border-gray-300 px-2.5 py-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              disabled={adding}
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={adding || label.trim().length < 2 || query.trim().length < 3}
              className="w-full rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {adding ? "创建并同步中..." : "创建并同步论文"}
            </button>
          </form>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-1">
          {directions.map((dir) => (
            <li key={dir.key}>
              <button
                onClick={() => onSelect(dir.key)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors ${
                  selected === dir.key
                    ? "bg-blue-50 text-blue-700 font-medium"
                    : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: dir.color }}
                  />
                  <span className="text-sm">{dir.label}</span>
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    selected === dir.key
                      ? "bg-blue-100 text-blue-700"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {dir.count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="px-4 py-4 border-t border-gray-200 space-y-3">
        <Button
          onClick={onSync}
          disabled={syncing}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm"
        >
          {syncing ? "同步中..." : "🔄 同步最新论文"}
        </Button>
        {syncStatus?.state === "running" && (
          <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">
            <div className="font-medium">{syncStatus.message}</div>
            <div className="mt-1">
              {syncStatus.completedDirections}/{syncStatus.totalDirections} 个方向
              {syncStatus.currentDirection ? ` · ${syncStatus.currentDirection}` : ""}
            </div>
            <div className="mt-1 text-blue-600">
              新增 {syncStatus.inserted} · 更新 {syncStatus.updated}
            </div>
          </div>
        )}
        {syncStatus?.state === "completed" && (
          <p className="text-xs text-green-700">
            最近一次同步已完成：{syncStatus.message}
            {syncStatus.errors.length > 0 ? `，${syncStatus.errors.length} 个来源可稍后重试` : ""}
          </p>
        )}
        {syncStatus?.state === "failed" && (
          <p className="text-xs text-red-700">最近一次同步失败：{syncStatus.message}</p>
        )}
        <div className="flex items-start gap-2">
          <svg className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <h3 className="text-sm font-medium text-gray-900 mb-1">阅读约定</h3>
            <p className="text-xs text-gray-600 leading-relaxed">
              前沿论文优先，经典论文单独标记。数据来自 OpenAlex、arXiv 等来源，可随时同步更新。
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
