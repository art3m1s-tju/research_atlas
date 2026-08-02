"use client";

import { useState, useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import PaperCard from "@/components/PaperCard";

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

interface Direction {
  key: string;
  label: string;
  count: number;
  color: string;
}

export default function Home() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [directions, setDirections] = useState<Direction[]>([]);
  const [selected, setSelected] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [searchMode, setSearchMode] = useState("citations");

  useEffect(() => {
    const timer = window.setTimeout(loadData, search ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [selected, search]);

  async function loadData() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selected !== "all") params.set("direction", selected);
      if (search) params.set("search", search);
      
      const [papersRes, dirsRes] = await Promise.all([
        fetch(`/api/papers?${params}`),
        fetch("/api/directions"),
      ]);
      
      const papersData = await papersRes.json();
      const dirsData = await dirsRes.json();
      
      setPapers(papersData.papers || []);
      setSearchMode(papersData.searchMode || "citations");
      setDirections(dirsData.directions || []);
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
      if (data.success) {
        await loadData();
      } else {
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
  const currentCount = currentDir?.count || papers.length;

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar
        directions={directions}
        selected={selected}
        onSelect={setSelected}
        onSync={handleSync}
        syncing={syncing}
        onAddDirection={handleAddDirection}
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
              <button
                onClick={() => window.open("obsidian://open?vault=Research", "_blank")}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                📓 在 Obsidian 打开
              </button>
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
          </div>

          {/* Stats */}
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{currentLabel}</h2>
              <p className="text-sm text-gray-600 mt-1">
                {loading ? "加载中..." : `${currentCount} 篇论文`}
              </p>
            </div>
            <div className="flex gap-2 text-sm">
              {search && searchMode === "hybrid" && (
                <span className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full">
                  语义 + 关键词
                </span>
              )}
              <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full">
                前沿: 1年内
              </span>
              <span className="px-3 py-1 bg-orange-50 text-orange-700 rounded-full">
                高引: 100+ 引用
              </span>
            </div>
          </div>

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
