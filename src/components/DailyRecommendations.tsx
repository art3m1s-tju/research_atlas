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
  userState?: { isRead?: boolean; isSaved?: boolean; isHidden?: boolean; note?: string };
}

interface DailySection {
  key: string;
  label: string;
  papers: DailyPaper[];
}

export default function DailyRecommendations() {
  const [sections, setSections] = useState<DailySection[]>([]);
  const [message, setMessage] = useState("");
  const [hasPreferenceData, setHasPreferenceData] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadRecommendations() {
      try {
        const response = await fetch("/api/daily-recommendations?limit=2", { cache: "no-store" });
        const data = await response.json();
        if (!active) return;
        setSections(data.directions || []);
        setMessage(data.message || "");
        setHasPreferenceData(Boolean(data.hasPreferenceData));
      } catch {
        if (active) setMessage("每日推荐暂时不可用，请稍后重试。");
      } finally {
        if (active) setLoading(false);
      }
    }
    loadRecommendations();
    const refresh = () => loadRecommendations();
    window.addEventListener("paper-feedback-updated", refresh);
    return () => {
      active = false;
      window.removeEventListener("paper-feedback-updated", refresh);
    };
  }, []);

  return (
    <section className="mb-8 rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-amber-50 p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">☀️</span>
            <h2 className="text-xl font-semibold text-gray-900">每日推荐</h2>
          </div>
          <p className="mt-1 text-sm text-gray-600">每个感兴趣方向精选 1–2 篇，优先近期前沿与高质量论文。</p>
        </div>
        <span className="rounded-full bg-white/80 px-3 py-1 text-xs text-gray-500">按行为更新</span>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl bg-white/70" />)}
        </div>
      ) : !hasPreferenceData ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-4 text-sm text-amber-900">
          {message}
          <div className="mt-2 text-xs text-amber-700">不会凭空猜测你的兴趣；收藏、已读和“不感兴趣”都会帮助它逐步形成。</div>
        </div>
      ) : sections.length === 0 ? (
        <div className="rounded-xl bg-white/70 px-4 py-4 text-sm text-gray-600">{message}</div>
      ) : (
        <div className="space-y-6">
          {sections.map((section) => (
            <div key={section.key}>
              <div className="mb-3 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-blue-500" />
                <h3 className="font-medium text-gray-900">{section.label}</h3>
                <span className="text-xs text-gray-500">精选 {section.papers.length} 篇</span>
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {section.papers.map((paper) => <PaperCard key={`${section.key}-${paper.id}`} paper={paper} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
