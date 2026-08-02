"use client";

import { useEffect, useState } from "react";
import PaperCard from "@/components/PaperCard";

interface DailyPaper {
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
  directionRelevance?: number | null;
  userState?: { isRead?: boolean; isSaved?: boolean; isHidden?: boolean; note?: string };
}

interface DailySection {
  key: string;
  label: string;
  kind?: "personal" | "exploration";
  papers: DailyPaper[];
}

interface RecommendationStats {
  saved: number;
  read: number;
  hidden: number;
  interacted: number;
  recommendationsLast7Days: number;
}

export default function DailyRecommendations() {
  const [sections, setSections] = useState<DailySection[]>([]);
  const [message, setMessage] = useState("");
  const [hasPreferenceData, setHasPreferenceData] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filterWindow, setFilterWindow] = useState("all");
  const [stats, setStats] = useState<RecommendationStats | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadRecommendations() {
      setLoading(true);
      try {
        const response = await fetch(`/api/daily-recommendations?limit=2&window=${filterWindow}`, { cache: "no-store" });
        const data = await response.json();
        if (!active) return;
        setSections(data.directions || []);
        setMessage(data.message || "");
        setHasPreferenceData(Boolean(data.hasPreferenceData));
        setStats(data.stats || null);
      } catch {
        if (active) setMessage("每日推荐暂时不可用，请稍后重试。");
      } finally {
        if (active) setLoading(false);
      }
    }
    loadRecommendations();
    const refresh = () => loadRecommendations();
    window.addEventListener("paper-feedback-updated", refresh);
    window.addEventListener("direction-preferences-updated", refresh);
    return () => {
      active = false;
      window.removeEventListener("paper-feedback-updated", refresh);
      window.removeEventListener("direction-preferences-updated", refresh);
    };
  }, [filterWindow]);

  return (
    <section className="mb-8 rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-amber-50 p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex items-center gap-2 text-left">
            <span className="text-xl">☀️</span>
            <h2 className="text-xl font-semibold text-gray-900">每日推荐</h2>
            <span className="text-sm text-gray-500">{expanded ? "⌃" : "⌄"}</span>
          </button>
          <p className="mt-1 text-sm text-gray-600">每个感兴趣方向精选 1–2 篇，优先近期前沿与高质量论文。</p>
        </div>
        <button type="button" onClick={() => setExpanded((value) => !value)} className="rounded-full bg-white/80 px-3 py-1 text-xs text-gray-500 hover:bg-white">{expanded ? "收起" : "展开"}</button>
      </div>

      {expanded && <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">论文范围：</span>
        {[
          ["all", "综合"],
          ["7d", "近 7 天"],
          ["30d", "近 30 天"],
          ["1y", "近 1 年"],
          ["classic", "经典补充"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilterWindow(key)}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${filterWindow === key ? "border-blue-600 bg-blue-600 text-white" : "border-gray-200 bg-white text-gray-600 hover:border-blue-300"}`}
          >
            {label}
          </button>
        ))}
        {stats && (
          <span className="ml-auto text-xs text-gray-500">
            近 30 天：收藏 {stats.saved} · 已读 {stats.read} · 隐藏 {stats.hidden} · 近 7 天推荐 {stats.recommendationsLast7Days}
          </span>
        )}
      </div>}

      {expanded && loading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl bg-white/70" />)}
        </div>
      ) : expanded && !hasPreferenceData ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-4 text-sm text-amber-900">
          {message}
          <div className="mt-2 text-xs text-amber-700">不会凭空猜测你的兴趣；收藏、已读和“不感兴趣”都会帮助它逐步形成。</div>
        </div>
      ) : expanded && sections.length === 0 ? (
        <div className="rounded-xl bg-white/70 px-4 py-4 text-sm text-gray-600">{message}</div>
      ) : expanded ? (
        <div className="space-y-6">
          {sections.map((section) => (
            <div key={section.key}>
              <div className="mb-3 flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${section.kind === "exploration" ? "bg-violet-500" : "bg-blue-500"}`} />
                <h3 className="font-medium text-gray-900">{section.label}</h3>
                <span className="text-xs text-gray-500">精选 {section.papers.length} 篇</span>
                {section.kind === "exploration" && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700">相邻方向</span>}
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {section.papers.slice().sort((left, right) => Number(Boolean(right.userState?.isSaved)) - Number(Boolean(left.userState?.isSaved))).map((paper) => <PaperCard key={`${section.key}-${paper.id}`} paper={paper} />)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
