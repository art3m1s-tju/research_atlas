"use client";

import { useEffect, useState } from "react";
import ClassificationPanel, { type ClassificationResult } from "@/components/ClassificationPanel";

type Paper = {
  dbId: number;
  id: string;
  title: string;
  authors: string;
  year: number | null;
  venue: string;
  citations: number;
  abstract: string;
  abstractZh: string | null;
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

type RelatedPaper = {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  venue: string;
  citations: number;
  relation: string;
  score?: number;
  local?: boolean;
};

type EvidenceItem = { type: string; label: string; content: string; source: string; confidence: string };
type TranslationState = { status: "pending" | "running" | "completed" | "failed"; source_url?: string | null; error?: string | null; previewUrl?: string | null; markdownUrl?: string | null; source_chars?: number; translated_chars?: number; updated_at?: string };

export default function PaperDetail({ id }: { id: string }) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [related, setRelated] = useState<{ similar: RelatedPaper[]; citedBy: RelatedPaper[]; references: RelatedPaper[]; message?: string }>({ similar: [], citedBy: [], references: [] });
  const [relevanceLabels, setRelevanceLabels] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<{ items: EvidenceItem[]; note?: string } | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [classification, setClassification] = useState<ClassificationResult | null>(null);
  const [classificationMessage, setClassificationMessage] = useState("");
  const [classificationProvider, setClassificationProvider] = useState<string>();
  const [classifying, setClassifying] = useState(false);
  const [creatingDirection, setCreatingDirection] = useState(false);
  const [translation, setTranslation] = useState<TranslationState | null>(null);
  const [translationStarting, setTranslationStarting] = useState(false);
  const [abstractTranslating, setAbstractTranslating] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/papers/${encodeURIComponent(id)}`).then((response) => response.json()),
      fetch(`/api/papers/${encodeURIComponent(id)}/related`).then((response) => response.json()).catch(() => ({ similar: [], citedBy: [], references: [] })),
      fetch(`/api/papers/${encodeURIComponent(id)}/evidence`).then((response) => response.json()).catch(() => ({ evidence: [], note: "证据卡暂时不可用" })),
      fetch(`/api/papers/${encodeURIComponent(id)}/translation`, { cache: "no-store" }).then((response) => response.json()).catch(() => ({ translation: null })),
    ]).then(([data, relationData, evidenceData, translationData]) => {
      setPaper(data.paper || null);
      setNote(data.paper?.userState?.note || "");
      setSaved(Boolean(data.paper?.userState?.isSaved));
      setRelated(relationData);
      setEvidence({ items: evidenceData.evidence || [], note: evidenceData.note });
      setTranslation(translationData.translation || null);
    }).finally(() => setLoading(false));
  }, [id]);

  const translationStatus = translation?.status;
  useEffect(() => {
    if (!translationStatus || !["pending", "running"].includes(translationStatus)) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/papers/${encodeURIComponent(id)}/translation`, { cache: "no-store" });
      if (response.ok) setTranslation((await response.json()).translation || null);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [id, translationStatus]);

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

  async function markRelevance(direction: string, label: "relevant" | "partial" | "irrelevant") {
    const response = await fetch(`/api/papers/${encodeURIComponent(id)}/relevance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction, label }),
    });
    if (response.ok) setRelevanceLabels((current) => ({ ...current, [direction]: label }));
  }

  async function loadFullTextEvidence() {
    setEvidenceLoading(true);
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(id)}/evidence?fulltext=1`, { cache: "no-store" });
      const data = await response.json();
      setEvidence({ items: data.evidence || [], note: data.note || data.warning });
    } finally {
      setEvidenceLoading(false);
    }
  }

  async function classifyPaper(createDirection = false) {
    if (!paper) return;
    if (createDirection) setCreatingDirection(true); else setClassifying(true);
    try {
      const response = await fetch("/api/classify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paperDbId: paper.dbId, apply: true, createDirection }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "分类失败");
      setClassification(data.classification);
      setClassificationProvider(data.provider);
      setClassificationMessage(data.message || (data.createdDirection ? `已创建研究方向：${data.createdDirection.label}` : ""));
    } catch (error) {
      setClassificationMessage(error instanceof Error ? error.message : "分类失败");
    } finally {
      setClassifying(false);
      setCreatingDirection(false);
    }
  }

  async function startTranslation() {
    setTranslationStarting(true);
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(id)}/translation`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "翻译任务启动失败");
      setTranslation((current) => ({ ...(current || {}), status: data.status || "pending", error: null } as TranslationState));
    } catch (error) {
      setTranslation({ status: "failed", error: error instanceof Error ? error.message : "翻译任务启动失败" });
    } finally { setTranslationStarting(false); }
  }

  async function translateAbstract() {
    setAbstractTranslating(true);
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(id)}/abstract-translation`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "中文摘要生成失败");
      setPaper((current) => current ? { ...current, abstractZh: data.abstractZh } : current);
    } catch (error) {
      setClassificationMessage(error instanceof Error ? error.message : "中文摘要生成失败");
    } finally { setAbstractTranslating(false); }
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
          <button type="button" onClick={() => classifyPaper()} disabled={classifying} className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700 hover:bg-sky-100 disabled:opacity-50">{classifying ? "分类中..." : "DeepSeek 分类"}</button>
          <button type="button" onClick={startTranslation} disabled={translationStarting || translation?.status === "pending" || translation?.status === "running"} className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">{translationStarting || translation?.status === "pending" || translation?.status === "running" ? "翻译处理中..." : translation?.status === "completed" ? "重新翻译" : "翻译全文"}</button>
        </div>
        {classification && <ClassificationPanel result={classification} provider={classificationProvider} message={classificationMessage} onCreateDirection={() => classifyPaper(true)} creating={creatingDirection} />}
        {!classification && classificationMessage && <p className="mt-3 text-xs text-amber-700">{classificationMessage}</p>}
        {translation && <section className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50/60 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-indigo-900">中文翻译工作流</h2>
            <span className="text-xs text-indigo-700">{translation.status === "completed" ? "已完成" : translation.status === "failed" ? "失败" : translation.status === "running" ? "翻译中" : "排队中"}</span>
          </div>
          {translation.status === "completed" && translation.previewUrl && <div className="mt-2 flex flex-wrap gap-2"><a href={translation.previewUrl} className="inline-block rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">打开中文译文预览</a>{translation.markdownUrl && <a href={translation.markdownUrl} className="inline-block rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">下载 Markdown</a>}</div>}
          {translation.status === "failed" && <p className="mt-2 text-xs leading-5 text-red-700">{translation.error || "翻译失败，请检查 DeepSeek 配置和 PDF 是否可访问。"}</p>}
          {(translation.status === "pending" || translation.status === "running") && <p className="mt-2 text-xs text-indigo-800">任务在后台执行，页面会自动刷新状态；长论文可能需要几分钟。</p>}
        </section>}

        {paper.summaryZh && <section className="mt-8 rounded-lg bg-amber-50 p-5"><h2 className="font-semibold text-amber-900">中文速览</h2><p className="mt-2 leading-7 text-gray-800">{paper.summaryZh}</p></section>}
        <section className="mt-8 rounded-xl border border-blue-100 bg-blue-50/60 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold text-gray-900">中文摘要</h2>{!paper.abstractZh && paper.abstract && <button type="button" onClick={translateAbstract} disabled={abstractTranslating} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">{abstractTranslating ? "生成中..." : "生成中文摘要"}</button>}</div><p className="mt-3 whitespace-pre-wrap leading-7 text-gray-700">{paper.abstractZh || "中文摘要尚未生成。"}</p></section>
        <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">英文摘要</h2><p className="mt-3 whitespace-pre-wrap leading-7 text-gray-700">{paper.abstract || "暂无摘要"}</p></section>
        {paper.innovationsZh.length > 0 && <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">核心创新</h2><ul className="mt-3 list-disc space-y-2 pl-6 text-gray-700">{paper.innovationsZh.map((item) => <li key={item}>{item}</li>)}</ul></section>}
        {paper.methodZh && <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">方法</h2><p className="mt-3 leading-7 text-gray-700">{paper.methodZh}</p></section>}
        {paper.resultsZh && <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">实验结果</h2><p className="mt-3 leading-7 text-gray-700">{paper.resultsZh}</p></section>}

        {evidence && <section className="mt-8 rounded-xl border border-amber-200 bg-amber-50/50 p-5">
          <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold text-gray-900">证据卡</h2><button type="button" onClick={loadFullTextEvidence} disabled={evidenceLoading} className="rounded border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-800 disabled:opacity-50">{evidenceLoading ? "解析全文中..." : "尝试解析 PDF 全文"}</button></div>
          <p className="mt-1 text-xs text-gray-600">{evidence.note}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {evidence.items.map((item) => <div key={item.type} className="rounded-lg bg-white p-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-gray-800">{item.label}</h3><span className="text-[10px] text-gray-500">{item.confidence === "medium" ? "中等置信度" : "低置信度"}</span></div><p className="mt-2 text-sm leading-6 text-gray-700">{item.content}</p><p className="mt-2 text-[10px] text-gray-400">来源：{item.source}</p></div>)}
          </div>
        </section>}

        <section className="mt-8 rounded-xl border border-gray-200 bg-slate-50 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-gray-900">论文关系</h2>
            <span className="text-xs text-gray-500">{related.message || "相似度与引用关系"}</span>
          </div>
          {[
            ["相似论文", related.similar],
            ["引用它的论文", related.citedBy],
            ["它引用的论文", related.references],
          ].map(([label, items]) => {
            const papers = items as RelatedPaper[];
            return papers.length ? (
              <div key={label as string} className="mt-5">
                <h3 className="text-sm font-semibold text-gray-800">{label as string}</h3>
                <div className="mt-2 space-y-2">
                  {papers.map((item) => {
                    const href = item.local ? `/papers/${encodeURIComponent(item.id)}` : `https://openalex.org/${item.id.replace("https://openalex.org/", "")}`;
                    return (
                      <a key={`${label}-${item.id}`} href={href} target={item.local ? undefined : "_blank"} rel={item.local ? undefined : "noreferrer"} className="block rounded-lg bg-white px-3 py-2 hover:bg-blue-50">
                        <div className="text-sm font-medium text-gray-900">{item.title}</div>
                        <div className="mt-1 text-xs text-gray-500">{item.venue || "来源待核实"} · {item.year || "年份未知"} · 引用 {item.citations}</div>
                      </a>
                    );
                  })}
                </div>
              </div>
            ) : null;
          })}
          {!related.similar.length && !related.citedBy.length && !related.references.length && <p className="mt-3 text-sm text-gray-500">暂时没有足够的论文关系数据。</p>}
        </section>

        <section className="mt-8 rounded-xl border border-gray-200 p-5">
          <h2 className="text-xl font-semibold text-gray-900">相关性反馈</h2>
          <p className="mt-1 text-sm text-gray-500">按方向标注后，后续推荐会逐渐减少类似误匹配。</p>
          <div className="mt-4 space-y-3">
            {paper.directions.map((direction) => (
              <div key={direction.key} className="flex flex-wrap items-center gap-2">
                <span className="w-36 text-sm text-gray-700">{direction.label}</span>
                {([["relevant", "相关"], ["partial", "部分相关"], ["irrelevant", "不相关"]] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => markRelevance(direction.key, value)}
                    className={`rounded border px-2.5 py-1 text-xs ${relevanceLabels[direction.key] === value ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-8"><h2 className="text-xl font-semibold text-gray-900">我的笔记</h2><textarea value={note} onChange={(event) => setNote(event.target.value)} className="mt-3 min-h-32 w-full rounded-lg border border-gray-300 p-3 text-sm focus:border-blue-500 focus:outline-none" placeholder="记录与你的研究、RoboRacer 或规划控制的关系..." /><button onClick={() => feedback("note", { note })} className="mt-2 rounded-lg bg-slate-800 px-4 py-2 text-sm text-white">保存笔记</button></section>
      </article>
    </main>
  );
}
