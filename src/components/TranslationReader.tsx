"use client";

import "katex/dist/katex.min.css";
import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";
import { renderToString } from "katex";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type PaperMeta = { title: string; authors: string; venue: string; year: number | null };
type TranslationMeta = { source_url?: string | null; title_zh?: string | null; title_original?: string | null; authors?: string | null; author_affiliations?: Array<{ name: string; affiliations: number[] }>; affiliations?: Array<{ index: number; text: string }>; structureReview?: { ambiguous?: string[]; reviewIssues?: string[]; captions?: Array<{ id: string; kind: string; number: number | null; text: string }>; objects?: Array<{ id: string; kind: string; captionId?: string | null; caption?: string | null; captionKind?: string | null; captionNumber?: number | null; asset?: string | null; assetUrl?: string | null; excerpt?: string; options?: Array<{ id: string; kind: string; number: number | null; text: string; current?: boolean }> }> } };

const translationSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames || []), "table", "thead", "tbody", "tfoot", "tr", "th", "td", "div", "img"])],
  attributes: {
    ...defaultSchema.attributes,
    table: [...(defaultSchema.attributes?.table || []), "border"],
    th: [...(defaultSchema.attributes?.th || []), "colSpan", "rowSpan"],
    td: [...(defaultSchema.attributes?.td || []), "colSpan", "rowSpan"],
    img: [...(defaultSchema.attributes?.img || []), "src", "alt", "title", "width", "height"],
  },
};

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

function plainText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => plainText(item)).join("");
  if (isValidElement(value)) return plainText((value.props as { children?: ReactNode }).children);
  return "";
}

function authorKey(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function renderAuthors(value: string, mappings: TranslationMeta["author_affiliations"]): ReactNode {
  const names = value.split(/\s*,\s*/).map((name) => name.trim()).filter(Boolean);
  const byName = new Map((mappings || []).map((entry) => [authorKey(entry.name), entry.affiliations]));
  const usePositionFallback = Boolean(mappings?.length && mappings.length === names.length);
  return names.map((name, index) => {
    const affiliations = byName.get(authorKey(name)) || (usePositionFallback ? mappings?.[index]?.affiliations : undefined) || [];
    return <span className="paper-author" key={`${name}-${index}`}>{name}{affiliations.length ? <sup>{affiliations.join(",")}</sup> : null}{index < names.length - 1 ? ", " : ""}</span>;
  });
}

function renderTableCellMath(value: ReactNode): ReactNode {
  if (typeof value === "string") {
    const parts = value.split(/(\\\([^\n]+\\\)|\$[^$\n]+\$)/g);
    return parts.map((part, index) => {
      const isMath = /^\\\(|^\$/.test(part);
      if (!isMath) return part;
      const body = part.startsWith("\\(") ? part.slice(2, -2) : part.slice(1, -1);
      try {
        return <span key={index} className="paper-inline-math" dangerouslySetInnerHTML={{ __html: renderToString(body, { displayMode: false, throwOnError: true }) }} />;
      } catch {
        return <code key={index} className="paper-formula-fallback">{body}</code>;
      }
    });
  }
  if (Array.isArray(value)) return value.map((item, index) => <span key={index}>{renderTableCellMath(item)}</span>);
  return value;
}

function bodyMarkdown(value: string) {
  const withoutTitle = value.replace(/^#\s+[^\n]+\n+/, "").replace(/^>\s*原文：[^\n]*\n*/gm, "").replace(/^\s*---\s*$/gm, "");
  const firstHeading = withoutTitle.search(/^#{2,6}\s+/m);
  const body = firstHeading > 0 ? withoutTitle.slice(firstHeading) : withoutTitle;
  return body.replace(/^\s*\$\$([^\n]+)\$\$\s*$/gm, (_match, formula: string) => `$$\n${formula.trim()}\n$$`).replace(/\n{3,}/g, "\n\n").trim();
}

export default function TranslationReader({ id }: { id: string }) {
  const [markdown, setMarkdown] = useState("");
  const [paper, setPaper] = useState<PaperMeta | null>(null);
  const [translationMeta, setTranslationMeta] = useState<TranslationMeta | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showOriginal, setShowOriginal] = useState(false);
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewSelections, setReviewSelections] = useState<Record<string, { captionId: string; kind: string }>>({});
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewMessage, setReviewMessage] = useState("");
  const canonicalId = decodePaperId(id);

  useEffect(() => {
    const encodedId = encodeURIComponent(decodePaperId(id));
    const translationContent = (async () => {
      const formal = await fetch(`/api/papers/${encodedId}/translation?file=translation_zh.md`);
      if (formal.ok) return { content: await formal.text(), review: false };
      const candidate = await fetch(`/api/papers/${encodedId}/translation?file=translation_candidate.md`);
      if (!candidate.ok) throw new Error((await formal.text()) || "译文尚未生成");
      return { content: await candidate.text(), review: true };
    })();
    Promise.all([
      translationContent,
      fetch(`/api/papers/${encodedId}`).then((response) => response.json()),
      fetch(`/api/papers/${encodedId}/translation`, { cache: "no-store" }).then((response) => response.json()),
    ]).then(([translationResult, paperData, translationData]) => {
      setMarkdown(translationResult.content);
      setPaper(paperData.paper || null);
      setTranslationMeta(translationData.translation || null);
      setReviewMode(translationResult.review || translationData.translation?.status === "needs_review");
      const reviewObjects = translationData.translation?.structureReview?.objects || [];
      setReviewSelections(Object.fromEntries(reviewObjects.filter((item: any) => item.captionId).map((item: any) => [item.id, { captionId: item.captionId, kind: item.kind }])));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "译文加载失败")).finally(() => setLoading(false));
  }, [id]);

  async function saveReviewDecisions() {
    const decisions = Object.entries(reviewSelections).filter(([, value]) => value.captionId).map(([objectId, value]) => ({ objectId, captionId: value.captionId, kind: value.kind }));
    if (!decisions.length) {
      setReviewMessage("请至少选择一个题注配对。");
      return;
    }
    setReviewSaving(true);
    setReviewMessage("");
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(canonicalId)}/translation/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "人工配对保存失败");
      setReviewMessage(data.message || "人工配对已保存");
      window.location.reload();
    } catch (reason) {
      setReviewMessage(reason instanceof Error ? reason.message : "人工配对保存失败");
    } finally {
      setReviewSaving(false);
    }
  }

  if (loading) return <main className="mx-auto max-w-4xl p-8 text-gray-500">正在加载中文译文...</main>;
  if (error) return <main className="mx-auto max-w-4xl p-8"><a href={`/papers/${encodeURIComponent(canonicalId)}`} className="text-blue-600 hover:underline">← 返回论文详情</a><p className="mt-6 rounded-lg bg-red-50 p-4 text-red-700">{error}</p></main>;

  return (
    <main className="paper-reader min-h-screen bg-[#f7f8fa] px-4 py-6 sm:px-8">
      <article className="mx-auto max-w-6xl rounded-2xl border border-gray-200 bg-white shadow-sm">
        <header className="border-b border-gray-200 px-6 py-6 sm:px-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <a href={`/papers/${encodeURIComponent(canonicalId)}`} className="text-sm text-blue-600 hover:underline">← 返回论文详情</a>
            <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setShowOriginal((value) => !value)} className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100">{showOriginal ? "收起原文 PDF" : "查看原文 PDF"}</button><a href={`/api/papers/${encodeURIComponent(canonicalId)}/translation?file=${reviewMode ? "translation_candidate.md" : "translation_zh.md"}`} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">下载 {reviewMode ? "待复核译文" : "Markdown"}</a></div>
          </div>
          <h1 className="paper-title mt-6 font-bold leading-tight text-gray-900">{translationMeta?.title_zh || paper?.title || "中文论文译文"}</h1>
          {paper && <div className="paper-meta mt-4"><p className="paper-authors"><span className="paper-meta-label">作者</span>{renderAuthors(translationMeta?.authors || paper.authors, translationMeta?.author_affiliations)}</p>{translationMeta?.affiliations?.length ? <div className="paper-affiliations">{translationMeta.affiliations.map((affiliation) => <p className="paper-affiliation" key={`${affiliation.index}-${affiliation.text}`}><sup>{affiliation.index}</sup>{affiliation.text}</p>)}</div> : null}<p className="paper-publication">{paper.venue || "发表渠道待核实"} · {paper.year || "年份未知"}</p></div>}
        </header>
        <div className="px-6 py-8 sm:px-10 sm:py-10">
          {reviewMode && <section className="mb-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900"><h2 className="text-lg font-semibold">待人工复核译文</h2><p className="mt-2 text-sm leading-6">这份译文已经生成，可以正常阅读，但部分图表、题注或结构关系没有被系统自动确认。请结合原文 PDF 判断，不要把未确认内容直接当作最终结论。</p>{translationMeta?.structureReview?.objects?.length ? <div className="mt-3 space-y-3 rounded-lg bg-white/70 p-3 text-xs leading-5"><p className="font-medium">选择正确的对象和题注配对</p>{translationMeta.structureReview.objects.slice(0, 12).map((item) => { const selection = reviewSelections[item.id] || { captionId: item.captionId || "", kind: item.kind }; return <div key={item.id} className="rounded-lg border border-amber-100 bg-white p-3"><div className="flex flex-wrap items-center gap-3"><strong>{item.id}</strong><span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">{item.kind === "figure" && !item.assetUrl ? "疑似图表数据" : item.kind === "figure" ? "图片/图" : item.kind === "table_image" ? "表格截图" : "原生表格"}</span>{item.assetUrl && <img src={item.assetUrl} alt={item.id} className="max-h-24 max-w-40 rounded border border-gray-200 object-contain" />}</div>{item.excerpt && <p className="mt-2 rounded bg-gray-50 p-2 text-gray-600">{item.excerpt}</p>}<div className="mt-2 grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]"><label className="self-center text-gray-600">对象类型</label><select value={selection.kind} onChange={(event) => setReviewSelections((current) => ({ ...current, [item.id]: { captionId: selection.captionId, kind: event.target.value } }))} className="rounded border border-gray-300 bg-white px-2 py-1"><option value="figure">图片/图</option><option value="table">原生表格</option><option value="table_image">表格截图</option></select><label className="self-center text-gray-600">对应题注</label><select value={selection.captionId} onChange={(event) => setReviewSelections((current) => ({ ...current, [item.id]: { captionId: event.target.value, kind: selection.kind } }))} className="min-w-0 rounded border border-gray-300 bg-white px-2 py-1"><option value="">请选择题注</option>{(item.options || []).map((option) => <option key={option.id} value={option.id}>{option.kind === "figure" ? "图" : "表"} {option.number ?? "?"}：{option.text.slice(0, 100)}{option.current ? "（当前）" : ""}</option>)}</select></div></div>; })}<div className="flex flex-wrap items-center gap-3"><button type="button" onClick={saveReviewDecisions} disabled={reviewSaving} className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-50">{reviewSaving ? "保存中..." : "保存人工配对"}</button>{reviewMessage && <span className="text-amber-800">{reviewMessage}</span>}</div></div> : null}</section>}
           {showOriginal && <section className="mb-8 rounded-xl border border-gray-200 bg-gray-50 p-3"><div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold text-gray-900">原文 PDF 对照</h2>{translationMeta?.source_url && <a href={translationMeta.source_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">新窗口打开</a>}</div>{translationMeta?.source_url ? <iframe title="论文原文 PDF" src={translationMeta.source_url} className="h-[70vh] w-full rounded-lg border border-gray-300 bg-white" /> : <p className="text-sm text-gray-500">原文 PDF 地址暂不可用。</p>}</section>}
          <div className="translation-prose min-w-0">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeRaw, [rehypeSanitize, translationSanitizeSchema], rehypeKatex]}
              components={{
                p: ({ children }) => {
                  const text = plainText(children).trim();
                  const caption = /^\*\*(?:图|表)\s*\d+\s*[.:：]\*\*/i.test(text) || /^(?:Figure|Fig\.?|Table|图|表)\s*\d+(?:\s*[.:：-]|\s|$)/i.test(text);
                  return <p className={caption ? "paper-caption" : undefined}>{children}</p>;
                },
                table: ({ children }) => <div className="paper-table-wrap"><table>{children}</table></div>,
                th: ({ children, ...props }) => <th {...props}>{renderTableCellMath(children)}</th>,
                td: ({ children, ...props }) => <td {...props}>{renderTableCellMath(children)}</td>,
                img: ({ src, alt, width, height }) => {
                  if (!src || typeof src !== "string") return null;
                  return <button type="button" className="paper-image-button" aria-label="放大查看图片" onClick={() => setImagePreview({ src, alt: alt || "论文图表" })}><img src={src} alt={alt || "论文图表"} width={width} height={height} style={{ width: width || undefined, height: height || undefined }} loading="lazy" /></button>;
                },
              }}
            >{bodyMarkdown(markdown)}</ReactMarkdown>
          </div>
        </div>
      </article>
      {imagePreview && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-6" role="dialog" aria-modal="true" aria-label="放大查看论文图表" onClick={() => setImagePreview(null)}><button type="button" className="absolute right-5 top-4 rounded-full bg-white/90 px-3 py-1 text-2xl leading-none text-gray-800" aria-label="关闭图片预览" onClick={() => setImagePreview(null)}>×</button><img src={imagePreview.src} alt={imagePreview.alt} className="max-h-[92vh] max-w-[94vw] object-contain" onClick={(event) => event.stopPropagation()} /></div>}
    </main>
  );
}
