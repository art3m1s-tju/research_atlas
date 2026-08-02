import * as React from "react";
import { Button } from "@/components/ui/button";

interface Direction {
  key: string;
  label: string;
  count: number;
  color: string;
}

interface DirectionPreference {
  key: string;
  label: string;
  color: string;
  weight: number;
  isActive: boolean;
  explicitlyConfigured: boolean;
}

interface ExclusionRule {
  id: number;
  direction: string;
  term: string;
  mode: string;
}

interface InterestCluster {
  id: number;
  name: string;
  color: string;
  directions: { direction: string; weight: number }[];
}

interface EvaluationSummary {
  labels: { label: string; count: number }[];
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
  onImportComplete?: () => Promise<void> | void;
}

export default function Sidebar({
  directions,
  selected,
  onSelect,
  onSync,
  syncing,
  syncStatus,
  onAddDirection,
  onImportComplete,
}: SidebarProps) {
  const [showForm, setShowForm] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState("");
  const [showPreferences, setShowPreferences] = React.useState(false);
  const [preferences, setPreferences] = React.useState<DirectionPreference[]>([]);
  const [preferencesLoading, setPreferencesLoading] = React.useState(false);
  const [preferencesError, setPreferencesError] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [rules, setRules] = React.useState<ExclusionRule[]>([]);
  const [ruleTerm, setRuleTerm] = React.useState("");
  const [clusters, setClusters] = React.useState<InterestCluster[]>([]);
  const [clusterName, setClusterName] = React.useState("");
  const [evaluation, setEvaluation] = React.useState<EvaluationSummary | null>(null);

  async function loadPreferences() {
    setPreferencesLoading(true);
    setPreferencesError("");
    try {
      const response = await fetch("/api/direction-preferences", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "兴趣方向加载失败");
      setPreferences(data.directions || []);
      const rulesResponse = await fetch("/api/exclusion-rules", { cache: "no-store" });
      const rulesData = await rulesResponse.json();
      setRules(rulesData.rules || []);
      const clustersResponse = await fetch("/api/interest-clusters", { cache: "no-store" });
      const clustersData = await clustersResponse.json();
      setClusters(clustersData.clusters || []);
      const evaluationResponse = await fetch("/api/evaluation", { cache: "no-store" });
      const evaluationData = await evaluationResponse.json();
      setEvaluation(evaluationData);
    } catch (err) {
      setPreferencesError(err instanceof Error ? err.message : "兴趣方向加载失败");
    } finally {
      setPreferencesLoading(false);
    }
  }

  async function addExclusionRule() {
    if (ruleTerm.trim().length < 2) return;
    const response = await fetch("/api/exclusion-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term: ruleTerm.trim(), direction: "all", mode: "exclude" }),
    });
    if (!response.ok) return;
    setRuleTerm("");
    const refreshed = await fetch("/api/exclusion-rules", { cache: "no-store" }).then((result) => result.json());
    setRules(refreshed.rules || []);
    window.dispatchEvent(new CustomEvent("direction-preferences-updated"));
  }

  async function removeExclusionRule(id: number) {
    await fetch(`/api/exclusion-rules?id=${id}`, { method: "DELETE" });
    setRules((current) => current.filter((rule) => rule.id !== id));
    window.dispatchEvent(new CustomEvent("direction-preferences-updated"));
  }

  async function createCluster() {
    const name = clusterName.trim();
    const directions = preferences.filter((item) => item.isActive).map((item) => ({ direction: item.key, weight: item.weight }));
    if (name.length < 2 || !directions.length) return;
    const response = await fetch("/api/interest-clusters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, directions }) });
    if (!response.ok) return;
    setClusterName("");
    const refreshed = await fetch("/api/interest-clusters", { cache: "no-store" }).then((result) => result.json());
    setClusters(refreshed.clusters || []);
  }

  async function deleteCluster(id: number) {
    await fetch(`/api/interest-clusters?id=${id}`, { method: "DELETE" });
    setClusters((current) => current.filter((cluster) => cluster.id !== id));
  }

  async function updatePreference(direction: string, isActive: boolean, weight: number) {
    const response = await fetch("/api/direction-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction, isActive, weight }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "兴趣方向更新失败");
    setPreferences((current) => current.map((item) => item.key === direction
      ? { ...item, isActive: data.isActive, weight: data.weight, explicitlyConfigured: true }
      : item));
    window.dispatchEvent(new CustomEvent("direction-preferences-updated"));
  }

  async function importBibtex(file: File) {
    setImporting(true);
    try {
      const bibtex = await file.text();
      const response = await fetch("/api/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bibtex, collection: "Zotero Library" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "导入失败");
      alert(`导入完成：${data.inserted} 篇新增，${data.duplicates} 篇已存在`);
      await onImportComplete?.();
      window.dispatchEvent(new CustomEvent("paper-feedback-updated"));
    } catch (err) {
      alert(err instanceof Error ? err.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

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
        <button
          type="button"
          onClick={() => {
            const next = !showPreferences;
            setShowPreferences(next);
            if (next && !preferences.length) loadPreferences();
          }}
          className="mt-3 text-xs font-medium text-gray-500 hover:text-blue-700"
        >
          {showPreferences ? "收起兴趣管理" : "⚙ 管理每日推荐方向"}
        </button>
        <label className={`mt-2 block cursor-pointer text-xs font-medium text-gray-500 hover:text-blue-700 ${importing ? "pointer-events-none opacity-50" : ""}`}>
          {importing ? "正在导入 Zotero..." : "⇧ 导入 Zotero/BibTeX"}
          <input
            type="file"
            accept=".bib,.bibtex,.txt"
            className="hidden"
            disabled={importing}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importBibtex(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {showPreferences && (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
            <p className="mb-2 text-[11px] leading-relaxed text-gray-500">
              打开后会进入“每日推荐”。权重越高，该方向越优先；关闭不会删除论文。
            </p>
            {preferencesLoading && <p className="text-xs text-gray-500">加载中...</p>}
            {preferencesError && <p className="text-xs text-red-600">{preferencesError}</p>}
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {preferences.map((preference) => (
                <div key={preference.key} className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-white">
                  <button
                    type="button"
                    onClick={() => updatePreference(preference.key, !preference.isActive, preference.weight).catch((err) => setPreferencesError(err.message))}
                    className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-[10px] ${preference.isActive ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300 bg-white text-transparent"}`}
                    aria-label={`${preference.isActive ? "关闭" : "开启"}${preference.label}`}
                  >
                    ✓
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-gray-700">{preference.label}</span>
                  <select
                    value={preference.weight}
                    onChange={(event) => updatePreference(preference.key, preference.isActive, Number(event.target.value)).catch((err) => setPreferencesError(err.message))}
                    className="w-14 rounded border border-gray-200 bg-white px-1 py-0.5 text-[10px] text-gray-600"
                    aria-label={`${preference.label}推荐权重`}
                  >
                    <option value="0.5">低</option>
                    <option value="1">标准</option>
                    <option value="1.5">高</option>
                    <option value="2">重点</option>
                  </select>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-gray-200 pt-3">
              <div className="mb-1 text-[11px] font-medium text-gray-600">全局排除关键词</div>
              <div className="flex gap-1">
                <input value={ruleTerm} onChange={(event) => setRuleTerm(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addExclusionRule(); }} placeholder="如 medical imaging" className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-[10px]" />
                <button type="button" onClick={addExclusionRule} className="rounded bg-slate-700 px-2 py-1 text-[10px] text-white">添加</button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {rules.filter((rule) => rule.direction === "all").map((rule) => (
                  <button key={rule.id} type="button" onClick={() => removeExclusionRule(rule.id)} className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700" title="点击删除">{rule.term} ×</button>
                ))}
              </div>
            </div>
            <div className="mt-3 border-t border-gray-200 pt-3">
              <div className="mb-1 text-[11px] font-medium text-gray-600">兴趣簇</div>
              <p className="mb-2 text-[10px] leading-relaxed text-gray-500">把当前启用的方向保存成一个研究主题，例如“RoboRacer 2026”。</p>
              <div className="flex gap-1">
                <input value={clusterName} onChange={(event) => setClusterName(event.target.value)} placeholder="兴趣簇名称" className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-[10px]" />
                <button type="button" onClick={createCluster} className="rounded bg-slate-700 px-2 py-1 text-[10px] text-white">保存</button>
              </div>
              <div className="mt-2 space-y-1">
                {clusters.map((cluster) => <div key={cluster.id} className="flex items-center justify-between rounded bg-white px-2 py-1 text-[10px] text-gray-700"><span>{cluster.name} · {cluster.directions.length} 个方向</span><button type="button" onClick={() => deleteCluster(cluster.id)} className="text-red-500">删除</button></div>)}
              </div>
            </div>
            {evaluation && evaluation.labels.length > 0 && (
              <div className="mt-3 border-t border-gray-200 pt-3 text-[10px] text-gray-500">
                近 90 天相关性标注：{evaluation.labels.map((item) => `${item.label} ${item.count}`).join(" · ")}
              </div>
            )}
          </div>
        )}
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
