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
type TranslationMeta = { source_url?: string | null; title_zh?: string | null; title_original?: string | null; authors?: string | null; author_affiliations?: Array<{ name: string; affiliations: number[] }>; affiliations?: Array<{ index: number; text: string }> };

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
    <main className="paper-reader min-h-screen bg-[#f7f8fa] px-4 py-6 sm:px-8">
      <article className="mx-auto max-w-6xl rounded-2xl border border-gray-200 bg-white shadow-sm">
        <header className="border-b border-gray-200 px-6 py-6 sm:px-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <a href={`/papers/${encodeURIComponent(canonicalId)}`} className="text-sm text-blue-600 hover:underline">← 返回论文详情</a>
            <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setShowOriginal((value) => !value)} className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100">{showOriginal ? "收起原文 PDF" : "查看原文 PDF"}</button><a href={`/api/papers/${encodeURIComponent(canonicalId)}/translation?file=translation_zh.md`} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">下载 Markdown</a></div>
          </div>
          <h1 className="paper-title mt-6 text-2xl font-bold leading-tight text-gray-900 sm:text-3xl">{translationMeta?.title_zh || paper?.title || "中文论文译文"}</h1>
          {paper && <div className="paper-meta mt-4"><p className="paper-authors"><span className="paper-meta-label">作者</span>{renderAuthors(translationMeta?.authors || paper.authors, translationMeta?.author_affiliations)}</p>{translationMeta?.affiliations?.length ? <div className="paper-affiliations">{translationMeta.affiliations.map((affiliation) => <p className="paper-affiliation" key={`${affiliation.index}-${affiliation.text}`}><sup>{affiliation.index}</sup>{affiliation.text}</p>)}</div> : null}<p className="paper-publication">{paper.venue || "发表渠道待核实"} · {paper.year || "年份未知"}</p></div>}
        </header>
        <div className="px-6 py-8 sm:px-10 sm:py-10">
          {showOriginal && <section className="mb-8 rounded-xl border border-gray-200 bg-gray-50 p-3"><div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold text-gray-900">原文 PDF 对照</h2>{translationMeta?.source_url && <a href={translationMeta.source_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">新窗口打开</a>}</div>{translationMeta?.source_url ? <iframe title="论文原文 PDF" src={translationMeta.source_url} className="h-[70vh] w-full rounded-lg border border-gray-300 bg-white" /> : <p className="text-sm text-gray-500">原文 PDF 地址暂不可用。</p>}</section>}
          <div className="translation-prose min-w-0">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeRaw, [rehypeSanitize, translationSanitizeSchema], rehypeKatex]}
              components={{
                p: ({ children }) => {
                  const text = plainText(children).trim();
                  const caption = /^\*\*(?:图|表)\s*\d+\s*[:：]\*\*/i.test(text) || /^(?:Figure|Fig\.?|Table)\s*\d+\s*[:：-]/i.test(text);
                  return <p className={caption ? "paper-caption" : undefined}>{children}</p>;
                },
                table: ({ children }) => <div className="paper-table-wrap"><table>{children}</table></div>,
                th: ({ children, ...props }) => <th {...props}>{renderTableCellMath(children)}</th>,
                td: ({ children, ...props }) => <td {...props}>{renderTableCellMath(children)}</td>,
                img: ({ src, alt }) => {
                  if (!src || typeof src !== "string") return null;
                  return <button type="button" className="paper-image-button" aria-label="放大查看图片" onClick={() => setImagePreview({ src, alt: alt || "论文图表" })}><img src={src} alt={alt || "论文图表"} loading="lazy" /></button>;
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
