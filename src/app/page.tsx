"use client";

import { useState, useEffect, useRef } from "react";
import Sidebar from "@/components/Sidebar";
import PaperCard from "@/components/PaperCard";
import DailyRecommendations from "@/components/DailyRecommendations";
import SearchResultCard from "@/components/SearchResultCard";
import DeepSeekBadge from "@/components/DeepSeekBadge";

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
  directions?: { key: string; label: string }[];
  sources?: string[];
  sourceUrls?: Record<string, string>;
  citationPercentile?: number | null;
  venueType?: string;
  venueTier?: number;
  isFrontier?: boolean;
  isClassic?: boolean;
  discoveryReason?: string;
  recommendationScore?: number;
  summaryZh?: string | null;
  innovationsZh?: string[];
  methodZh?: string | null;
  resultsZh?: string | null;
  limitationsZh?: string | null;
  publicationChannel?: string;
  publicationStatus?: string;
  venueVerified?: boolean;
  venueConfidence?: number;
  qualityScore?: number;
  qualityLabel?: string;
}

interface Direction {
  key: string;
  label: string;
  count: number;
  color: string;
}

interface DatabaseStats {
  total: number;
  visible: number;
  hidden: number;
}

interface SearchPaper {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  venue: string;
  citations: number;
  abstract: string;
  doi: string | null;
  pdfUrl: string | null;
  sourceUrl: string;
  source: string;
}

interface SyncStatus {
  state: "idle" | "running" | "completed" | "failed";
  phase: string;
  message: string;
  currentDirection: string | null;
  completedDirections: number;
  totalDirections: number;
  recordsFetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  errors: string[];
}

export default function Home() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [directions, setDirections] = useState<Direction[]>([]);
  const [databaseStats, setDatabaseStats] = useState<DatabaseStats | null>(null);
  const [selected, setSelected] = useState("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState("recommended");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [searchMode, setSearchMode] = useState("recommended");
  const [searchScope, setSearchScope] = useState<"library" | "openalex">("library");
  const [externalPapers, setExternalPapers] = useState<SearchPaper[]>([]);
  const [searchError, setSearchError] = useState("");
  const previousSyncState = useRef<string>("idle");

  useEffect(() => {
    const timer = window.setTimeout(loadData, search ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [selected, search, view, searchScope]);

  useEffect(() => {
    let active = true;
    async function pollSyncStatus() {
      try {
        const response = await fetch("/api/sync/status", { cache: "no-store" });
        const data = await response.json();
        if (!active || !data.status) return;
        const status = data.status as SyncStatus;
        setSyncStatus(status);
        setSyncing(status.state === "running");
        if (previousSyncState.current === "running" && status.state !== "running") {
          await loadData();
        }
        previousSyncState.current = status.state;
      } catch {
        // The page remains usable if the optional status endpoint is unavailable.
      }
    }
    pollSyncStatus();
    const timer = window.setInterval(pollSyncStatus, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selected !== "all") params.set("direction", selected);
      if (search) params.set("search", search);
      params.set("view", view);
      
      const [papersRes, dirsRes] = await Promise.all([
        searchScope === "openalex" && search.trim()
          ? fetch(`/api/search?query=${encodeURIComponent(search.trim())}&limit=30`)
          : fetch(`/api/papers?${params}`),
        fetch("/api/directions"),
      ]);

      const papersData = await papersRes.json();
      const dirsData = await dirsRes.json();

      if (searchScope === "openalex" && search.trim()) {
        setExternalPapers(papersData.papers || []);
        setPapers([]);
        setSearchMode("OpenAlex 全网搜索");
        setSearchError(papersData.error || "");
      } else {
        setExternalPapers([]);
        setPapers(papersData.papers || []);
        setSearchMode(papersData.searchMode || "citations");
        setSearchError("");
      }
      setDirections(dirsData.directions || []);
      setDatabaseStats(dirsData.databaseStats || null);
    } catch (error) {
      console.error("Load error:", error);
    }
    setLoading(false);
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert("同步失败：" + (data.error || "未知错误"));
      }
    } catch (error) {
      alert("同步失败：" + error);
    }
    setSyncing(false);
  }

  async function handleAddDirection(label: string, query: string) {
    const res = await fetch("/api/directions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, query }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "新增方向失败");
    await loadData();
    setSelected(data.direction.key);
  }

  const currentDir = directions.find(d => d.key === selected);
  const currentLabel = currentDir?.label || "全部方向";
  const currentCount = searchScope === "openalex" && search ? externalPapers.length : view === "recommended" && !search ? currentDir?.count || papers.length : papers.length;
  const viewLabel = searchScope === "openalex" && search ? "OpenAlex 全网结果" : view === "frontier" ? "前沿论文" : view === "classic" ? "经典必读" : "我的推荐";

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar
        directions={directions}
        selected={selected}
        onSelect={setSelected}
        onSync={handleSync}
        syncing={syncing}
        syncStatus={syncStatus}
        onAddDirection={handleAddDirection}
        onImportComplete={loadData}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-8 py-8">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 mb-1">
                  AI Research Atlas
                </h1>
                <p className="text-gray-600">
                  自动驾驶论文知识图谱 · 聚焦端到端、规划控制、世界模型
                </p>
              </div>
              <div className="flex items-center gap-3">
                <DeepSeekBadge />
                <button
                  onClick={() => window.open("obsidian://open?vault=Research", "_blank")}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  📓 在 Obsidian 打开
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索论文标题、作者、摘要..."
                className="w-full px-4 py-3 pl-11 bg-white border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <svg
                className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <div className="mt-2 flex gap-2">
              {[
                ["library", "搜索本地 Atlas"],
                ["openalex", "搜索 OpenAlex 全网"],
              ].map(([key, label]) => (
                <button key={key} type="button" onClick={() => setSearchScope(key as "library" | "openalex")} className={`rounded-full border px-3 py-1 text-xs ${searchScope === key ? "border-blue-600 bg-blue-600 text-white" : "border-gray-200 bg-white text-gray-600 hover:border-blue-300"}`}>
                  {label}
                </button>
              ))}
              {searchScope === "openalex" && <span className="self-center text-xs text-gray-500">搜索结果可直接收藏入库</span>}
            </div>
          </div>

          {/* Stats */}
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{currentLabel}</h2>
              <p className="text-sm text-gray-600 mt-1">
                {loading ? "加载中..." : `${currentCount} 篇 · ${viewLabel}`}
              </p>
              {!loading && databaseStats && (
                <p className="mt-1 text-xs text-gray-400">
                  数据库共 {databaseStats.total} 条，隐藏低相关 {databaseStats.hidden} 条
                </p>
              )}
            </div>
            <div className="flex gap-2 text-sm">
              {search && searchMode === "hybrid" && (
                <span className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full">
                  语义 + 关键词
                </span>
              )}
            </div>
          </div>

          <DailyRecommendations />

          {searchScope === "library" && <div className="mb-6 flex flex-wrap gap-2">
            {[
              { key: "recommended", label: "我的推荐", hint: "前沿优先" },
              { key: "frontier", label: "前沿论文", hint: "近两年" },
              { key: "classic", label: "经典必读", hint: "基础锚点" },
            ].map((item) => (
              <button
                key={item.key}
                onClick={() => setView(item.key)}
                className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                  view === item.key
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-gray-200 bg-white text-gray-700 hover:border-blue-300 hover:bg-blue-50"
                }`}
              >
                {item.label}
                <span className={`ml-2 text-xs ${view === item.key ? "text-blue-100" : "text-gray-400"}`}>
                  {item.hint}
                </span>
              </button>
            ))}
          </div>}

          {/* Papers Grid */}
          {loading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-24 mb-3"></div>
                  <div className="h-6 bg-gray-200 rounded w-full mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
                  <div className="h-3 bg-gray-200 rounded w-full mb-2"></div>
                  <div className="h-3 bg-gray-200 rounded w-full mb-2"></div>
                  <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                </div>
              ))}
            </div>
          ) : searchScope === "openalex" && search ? (
            externalPapers.length === 0 ? (
              <div className="py-20 text-center text-gray-500">{searchError || "没有找到 OpenAlex 结果，尝试论文标题、DOI 或关键词。"}</div>
            ) : (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">{externalPapers.map((paper) => <SearchResultCard key={paper.id} paper={paper} />)}</div>
            )
          ) : papers.length === 0 ? (
            <div className="text-center py-20">
              <div className="text-6xl mb-4">📚</div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">暂无论文</h3>
              <p className="text-gray-600 mb-6">
                {search ? "尝试调整搜索关键词" : "点击右上角同步按钮获取最新论文"}
              </p>
              {!search && (
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                >
                  {syncing ? "同步中..." : "立即同步"}
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {papers.map((paper) => (
                <PaperCard key={paper.id} paper={paper} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
