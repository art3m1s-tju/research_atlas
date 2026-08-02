"use client";

import { useEffect, useState } from "react";

type Paper = {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  venue: string;
  citations: number;
  abstract: string;
  doi: string | null;
  pdfUrl: string | null;
  directions: { key: string; label: string }[];
  summaryZh: string | null;
  innovationsZh: string[];
  methodZh: string | null;
  resultsZh: string | null;
  limitationsZh: string | null;
  publicationStatus: string;
  userState: { isRead: boolean; isSaved: boolean; note: string };
};

export default function PaperDetail({ id }: { id: string }) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/papers/${encodeURIComponent(id)}`)
      .then((response) => response.json())
      .then((data) => {
        setPaper(data.paper || null);
        setNote(data.paper?.userState?.note || "");
        setSaved(Boolean(data.paper?.userState?.isSaved));
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function feedback(action: string, payload: Record<string, unknown> = {}) {
    const response = await fetch(`/api/papers/${encodeURIComponent(id)}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!response.ok) return;
    const data = await response.json();
    setSaved(Boolean(data.userState?.isSaved));
    if (paper) setPaper({ ...paper, userState: data.userState });
  }

  if (loading) return <main className="mx-auto max-w-4xl p-8 text-gray-500">加载论文中...</main>;
  if (!paper) return <main className="mx-auto max-w-4xl p-8 text-red-600">论文不存在</main>;

  return (
    <main className="min-h-screen bg-gray-50 px-6 py-8">
      <article className="mx-auto max-w-4xl rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <a href="/" className="text-sm text-blue-600 hover:underline">← 返回论文列表</a>
        <div className="mt-5 flex flex-wrap gap-2 text-xs text-gray-600">
          {paper.directions.map((direction) => <span key={direction.key} className="rounded-full bg-blue-50 px-3 py-1 text-blue-700">{direction.label}</span>)}
          <span className="rounded-full bg-gray-100 px-3 py-1">{paper.publicationStatus}</span>
        </div>
        <h1 className="mt-4 text-3xl font-bold leading-tight text-gray-900">{paper.title}</h1>
        <p className="mt-3 text-sm text-gray-600">{paper.authors}</p>
        <p className="mt-2 text-sm text-gray-500">{paper.venue} · {paper.year || "年份未知"} · 引用 {paper.citations}</p>

        <div className="mt-6 flex flex-wrap gap-2">
          <button onClick={() => feedback(paper.userState.isRead ? "unread" : "read")} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
            {paper.userState.isRead ? "取消已读" : "标记已读"}
          </button>
          <button onClick={() => feedback(saved ? "unsave" : "save")} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
            {saved ? "取消收藏" : "收藏"}
          </button>
          {paper.pdfUrl && <a href={paper.pdfUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">打开 PDF</a>}
          {paper.doi && <a href={paper.doi} target="_blank" rel="noreferrer" className="rounded-lg border px-3 py-2 text-sm">打开 DOI</a>}
        </div>

        {paper.summaryZh && <section className="mt-8 rounded-lg bg-amber-50 p-5"><h2 className="font-semibold text-amber-900">中文速览</h2><p className="mt-2 leading-7 text-gray-800">{paper.summaryZh}</p></section>}
        <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">摘要</h2><p className="mt-3 whitespace-pre-wrap leading-7 text-gray-700">{paper.abstract || "暂无摘要"}</p></section>
        {paper.innovationsZh.length > 0 && <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">核心创新</h2><ul className="mt-3 list-disc space-y-2 pl-6 text-gray-700">{paper.innovationsZh.map((item) => <li key={item}>{item}</li>)}</ul></section>}
        {paper.methodZh && <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">方法</h2><p className="mt-3 leading-7 text-gray-700">{paper.methodZh}</p></section>}
        {paper.resultsZh && <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">实验结果</h2><p className="mt-3 leading-7 text-gray-700">{paper.resultsZh}</p></section>}

        <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">我的笔记</h2><textarea value={note} onChange={(event) => setNote(event.target.value)} className="mt-3 min-h-32 w-full rounded-lg border border-gray-300 p-3 text-sm focus:border-blue-500 focus:outline-none" placeholder="记录与你的研究、RoboRacer 或规划控制的关系..." /><button onClick={() => feedback("note", { note })} className="mt-2 rounded-lg bg-slate-800 px-4 py-2 text-sm text-white">保存笔记</button></section>
      </article>
    </main>
  );
}
