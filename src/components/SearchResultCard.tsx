"use client";

import { useState } from "react";

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

export default function SearchResultCard({ paper }: { paper: SearchPaper }) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function savePaper() {
    setSaving(true);
    try {
      const response = await fetch("/api/library/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(paper) });
      if (response.ok) {
        setSaved(true);
        window.dispatchEvent(new CustomEvent("paper-feedback-updated"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-xs text-gray-500"><span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">OpenAlex 全网结果</span><span>{paper.year || "年份未知"}</span><span>引用 {paper.citations.toLocaleString()}</span></div>
      <h3 className="text-lg font-semibold leading-snug text-gray-900">{paper.title}</h3>
      <p className="mt-2 text-sm text-gray-600">{paper.authors || "作者未知"}</p>
      <p className="mt-1 text-xs text-gray-500">{paper.venue || "发表渠道待核实"}</p>
      {paper.abstract && <p className="mt-3 line-clamp-4 text-sm leading-6 text-gray-700">{paper.abstract}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={savePaper} disabled={saving || saved} className={`rounded-lg px-3 py-2 text-sm ${saved ? "bg-emerald-100 text-emerald-700" : "bg-blue-600 text-white hover:bg-blue-700"}`}>{saving ? "收藏中..." : saved ? "已收藏入库" : "收藏到 Atlas"}</button>
        <a href={paper.sourceUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">打开 OpenAlex</a>
        {paper.pdfUrl && <a href={paper.pdfUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">PDF</a>}
      </div>
    </article>
  );
}
