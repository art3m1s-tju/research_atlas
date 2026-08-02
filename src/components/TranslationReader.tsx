"use client";

import "katex/dist/katex.min.css";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type PaperMeta = { title: string; authors: string; venue: string; year: number | null };
type TranslationMeta = { source_url?: string | null };

function decodePaperId(value: string) {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  return decoded;
}

export default function TranslationReader({ id }: { id: string }) {
  const [markdown, setMarkdown] = useState("");
  const [paper, setPaper] = useState<PaperMeta | null>(null);
  const [translationMeta, setTranslationMeta] = useState<TranslationMeta | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const canonicalId = decodePaperId(id);

  useEffect(() => {
    const encodedId = encodeURIComponent(decodePaperId(id));
    Promise.all([
      fetch(`/api/papers/${encodedId}/translation?file=translation_zh.md`).then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || "译文尚未生成");
        return response.text();
      }),
      fetch(`/api/papers/${encodedId}`).then((response) => response.json()),
      fetch(`/api/papers/${encodedId}/translation`, { cache: "no-store" }).then((response) => response.json()),
    ]).then(([content, paperData, translationData]) => {
      setMarkdown(content);
      setPaper(paperData.paper || null);
      setTranslationMeta(translationData.translation || null);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "译文加载失败")).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <main className="mx-auto max-w-4xl p-8 text-gray-500">正在加载中文译文...</main>;
  if (error) return <main className="mx-auto max-w-4xl p-8"><a href={`/papers/${encodeURIComponent(canonicalId)}`} className="text-blue-600 hover:underline">← 返回论文详情</a><p className="mt-6 rounded-lg bg-red-50 p-4 text-red-700">{error}</p></main>;

  return (
    <main className="min-h-screen bg-[#f7f8fa] px-4 py-6 sm:px-8">
      <article className="mx-auto max-w-5xl rounded-2xl border border-gray-200 bg-white shadow-sm">
        <header className="border-b border-gray-200 px-6 py-6 sm:px-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <a href={`/papers/${encodeURIComponent(canonicalId)}`} className="text-sm text-blue-600 hover:underline">← 返回论文详情</a>
            <a href={`/api/papers/${encodeURIComponent(canonicalId)}/translation?file=translation_zh.md`} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">下载 Markdown 原文</a>
          </div>
          <h1 className="mt-6 text-2xl font-bold leading-tight text-gray-900 sm:text-3xl">{paper?.title || "中文论文译文"}</h1>
          {paper && <p className="mt-3 text-sm text-gray-500">{paper.authors} · {paper.venue || "发表渠道待核实"} · {paper.year || "年份未知"}</p>}
          <div className="mt-4 rounded-lg bg-indigo-50 px-4 py-3 text-xs leading-5 text-indigo-800">这是基于开放 PDF 的机器翻译阅读稿。公式、数字、模型名和引用请结合原文核对。</div>
        </header>
        <div className="grid gap-6 px-6 py-8 sm:px-10 sm:py-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <div className="translation-prose min-w-0">
            <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">左侧是中文阅读稿；右侧是原文 PDF 对照。公式、图表和版式以原文 PDF 为准，避免 PDF 转文本时丢失信息。</div>
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{markdown}</ReactMarkdown>
          </div>
          <aside className="min-w-0">
            <div className="sticky top-4 rounded-xl border border-gray-200 bg-gray-50 p-3">
              <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold text-gray-900">原文 PDF 对照</h2>{translationMeta?.source_url && <a href={translationMeta.source_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">新窗口打开</a>}</div>
              {translationMeta?.source_url ? <iframe title="论文原文 PDF" src={translationMeta.source_url} className="h-[70vh] w-full rounded-lg border border-gray-300 bg-white" /> : <p className="text-sm text-gray-500">原文 PDF 地址暂不可用。</p>}
            </div>
          </aside>
        </div>
      </article>
    </main>
  );
}
