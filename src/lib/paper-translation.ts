import { createHash } from "node:crypto";

export const TRANSLATION_FORMAT_VERSION = "structured-pdf-v14-source-ir";
export const TRANSLATION_PROMPT_VERSION = "academic-markdown-v9-source-ir";

export type SourceQualityIssue = {
  code: "repeated_text" | "unbalanced_html" | "unbalanced_math" | "orphan_fragment" | "oversized_line";
  message: string;
  line?: number;
};

export type SourceQualityReport = {
  ok: boolean;
  issues: SourceQualityIssue[];
  stats: { lines: number; chars: number; tables: number; images: number };
};

export type SourceRepair = {
  code: "repeated_text_tail" | "orphan_fragment" | "currency_dollar_escaped";
  line: number;
  message: string;
};

function repeatedRun(text: string) {
  const normalized = text.replace(/\s+/g, "");
  let longest = 0;
  let unit = "";
  let repairStart = -1;
  let repairUnit = "";
  for (const size of [2, 3, 4]) {
    for (let index = 0; index + size * 20 <= normalized.length; index += 1) {
      const candidate = normalized.slice(index, index + size);
      let count = 1;
      while (normalized.slice(index + count * size, index + (count + 1) * size) === candidate) count += 1;
      if (count * size > longest) {
        longest = count * size;
        unit = candidate;
      }
      if (count >= 20 && count * size >= 80 && (repairStart < 0 || index < repairStart)) {
        repairStart = index;
        repairUnit = candidate;
      }
    }
  }
  const rawStart = repairStart >= 0 && repairUnit ? text.indexOf(repairUnit.repeat(20)) : -1;
  return { longest, unit, repairUnit, repairStart: rawStart };
}

/**
 * Repair only high-confidence parser damage before the source quality gate.
 * We never rewrite ordinary prose here: the repeated suffix must dominate a
 * long line, and truncated fragments are limited to known missing prefixes.
 */
export function repairSourceQuality(markdown: string) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const repairs: SourceRepair[] = [];
  const orphanPrefixes: Record<string, string> = {
    gardless: "regardless",
    nter: "enter",
    dardless: "regardless",
    ontent: "content",
    igure: "Figure",
    able: "Table",
  };
  lines.forEach((line, index) => {
    const text = line.trim();
    if (!text || /<table\b/i.test(text)) return;
    // PaddleOCR frequently turns currency amounts ("$12 billion") into an odd
    // number of $ tokens, which then fails the math-delimiter gate and forces a
    // full cloud OCR retry. Only repair lines where every $ starts a number, so
    // real inline/display math is never touched.
    const dollars = [...text.matchAll(/(?<!\\)\$/g)];
    if (dollars.length > 0 && dollars.length % 2 === 1 && dollars.every((match) => /^\d/.test(text.slice((match.index || 0) + 1)))) {
      const repairedLine = text.replace(/(?<!\\)\$(?=\d)/g, "\\$");
      lines[index] = line.replace(text, repairedLine);
      repairs.push({ code: "currency_dollar_escaped", line: index + 1, message: `第 ${index + 1} 行已转义 ${dollars.length} 个货币符号 $，避免被误判为未闭合公式` });
      return;
    }
    const run = repeatedRun(text);
    const normalizedLength = text.replace(/\s+/g, "").length;
    if (text.length > 600 && run.repairStart >= 24 && normalizedLength - text.slice(0, run.repairStart).replace(/\s+/g, "").length >= 120) {
      const prefix = line.slice(0, line.indexOf(text) + run.repairStart).trimEnd();
      if (prefix.length >= 24) {
        lines[index] = prefix;
        repairs.push({ code: "repeated_text_tail", line: index + 1, message: `第 ${index + 1} 行已裁剪高置信度重复 OCR 尾部（${run.repairUnit}）` });
        return;
      }
    }
    const orphan = text.match(/^(gardless|nter|dardless|ontent|igure|able)\b/i);
    if (orphan) {
      const replacement = orphanPrefixes[orphan[1].toLowerCase()];
      lines[index] = line.replace(new RegExp(`^\\s*${orphan[1]}`, "i"), replacement);
      repairs.push({ code: "orphan_fragment", line: index + 1, message: `第 ${index + 1} 行已恢复截断词 ${orphan[1]} → ${replacement}` });
    }
  });
  return { markdown: lines.join("\n"), repairs };
}

/** Reject obvious OCR hallucinations before they can enter translation chunks. */
export function inspectSourceQuality(markdown: string): SourceQualityReport {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const issues: SourceQualityIssue[] = [];
  const add = (issue: SourceQualityIssue) => {
    if (!issues.some((item) => item.code === issue.code && item.line === issue.line)) issues.push(issue);
  };
  lines.forEach((line, index) => {
    const text = line.trim();
    if (!text) return;
    const run = repeatedRun(text);
    if (run.longest >= 40 && run.longest / Math.max(1, text.replace(/\s+/g, "").length) >= 0.12) {
      add({ code: "repeated_text", line: index + 1, message: `第 ${index + 1} 行存在重复 OCR 文本（${run.unit} × ${Math.floor(run.longest / Math.max(1, run.unit.length))}）` });
    }
    if (text.length > 6000 && !/<table\b[\s\S]*<\/table>/i.test(text)) add({ code: "oversized_line", line: index + 1, message: `第 ${index + 1} 行异常长（${text.length} 字符）` });
    if (/^(?:gardless|nter|dardless|ontent|igure|able)\b/i.test(text)) {
      add({ code: "orphan_fragment", line: index + 1, message: `第 ${index + 1} 行疑似页面截断片段：${text.slice(0, 40)}` });
    }
  });
  for (const [tag, close] of [["table", "table"], ["tr", "tr"], ["td", "td"], ["th", "th"]] as const) {
    const opens = (markdown.match(new RegExp(`<${tag}\\b`, "gi")) || []).length;
    const closes = (markdown.match(new RegExp(`</${close}>`, "gi")) || []).length;
    if (opens !== closes) add({ code: "unbalanced_html", message: `<${tag}> 标签不成对：${opens}/${closes}` });
  }
  const dollars = (markdown.match(/(?<!\\)\$/g) || []).length;
  if (dollars % 2 !== 0 || (markdown.match(/\$\$/g) || []).length % 2 !== 0) add({ code: "unbalanced_math", message: "公式分隔符不成对" });
  return {
    ok: issues.length === 0,
    issues,
    stats: {
      lines: lines.length,
      chars: markdown.length,
      tables: (markdown.match(/<table\b/gi) || []).length,
      images: (markdown.match(/!\[[^\]]*\]\([^)]*\)|<img\b/gi) || []).length,
    },
  };
}

/**
 * Completeness gate for the local pdftotext fallback. `inspectSourceQuality`
 * only catches corrupted text; this checks whether the extraction plausibly
 * captured the whole document (text volume per page, embedded images).
 */
export function assessTextExtractionCompleteness(
  markdown: string,
  stats: { pages?: number; embeddedImages?: number; minCharsPerPage?: number; minChars?: number },
) {
  const issues: string[] = [];
  const textChars = markdown.replace(/\s+/g, "").length;
  const pages = stats.pages || 0;
  const minCharsPerPage = stats.minCharsPerPage ?? 500;
  if (pages > 0) {
    if (textChars < pages * minCharsPerPage) {
      issues.push(`文本覆盖率过低：约 ${Math.round(textChars / pages)} 字/页（${pages} 页），疑似扫描件或内容丢失`);
    }
  } else if (textChars < (stats.minChars ?? 1000)) {
    issues.push("无法确认页数且文本过短");
  }
  if ((stats.embeddedImages || 0) > 0 && !/!\[[^\]]*\]\(|<img\b/i.test(markdown)) {
    issues.push(`PDF 含 ${stats.embeddedImages} 个嵌入图片，但本地提取没有任何图片引用，图片/表格可能已丢失`);
  }
  return { ok: issues.length === 0, issues, textChars };
}

type TranslationRuntime = {
  model?: string;
  parser?: string;
  formulaEnabled?: string;
  glossary?: string;
};

export function translationSourceHash(
  paper: { title: string; abstract?: string | null; pdf_url?: string | null; doi?: string | null },
  runtime: TranslationRuntime = {},
) {
  return createHash("sha256").update(JSON.stringify({
    format: TRANSLATION_FORMAT_VERSION,
    prompt: TRANSLATION_PROMPT_VERSION,
    title: paper.title,
    abstract: paper.abstract || "",
    pdfUrl: paper.pdf_url || "",
    doi: paper.doi || "",
    model: runtime.model || "",
    parser: runtime.parser || "auto",
    formulaEnabled: runtime.formulaEnabled || "1",
    glossary: runtime.glossary || "",
  })).digest("hex");
}

export function translationDirectory(paperId: number) {
  return `data/translations/${paperId}`;
}

function looksLikePdfUrl(value: string) {
  return /arxiv\.org\/pdf|\.pdf(?:[?#]|$)|download/i.test(value);
}

export function translationUrlCandidates(paper: { pdf_url?: string | null; arxiv_id?: string | null; doi?: string | null }, alternatives: Array<{ pdf_url?: string | null; arxiv_id?: string | null }> = []) {
  const doiUrl = paper.doi && !/^https?:\/\//i.test(paper.doi)
    ? `https://doi.org/${paper.doi.replace(/^doi:\s*/i, "")}`
    : paper.doi || "";
  const urls = [paper.pdf_url || "", doiUrl, ...alternatives.flatMap((item) => [item.pdf_url || ""]), paper.arxiv_id ? `https://arxiv.org/pdf/${paper.arxiv_id.replace(/\.pdf$/, "")}.pdf` : "", ...alternatives.map((item) => item.arxiv_id ? `https://arxiv.org/pdf/${item.arxiv_id.replace(/\.pdf$/, "")}.pdf` : "")].filter(Boolean);
  return [...new Set(urls)].sort((left, right) => Number(looksLikePdfUrl(right)) - Number(looksLikePdfUrl(left)));
}

function htmlAttribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] || "";
}

/** Extract publisher PDF URLs from DOI/OJS landing pages without accepting arbitrary page links. */
export function pdfLinksFromLandingHtml(html: string, baseUrl: string) {
  const links: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (htmlAttribute(match[0], "name").toLowerCase() === "citation_pdf_url") links.push(htmlAttribute(match[0], "content"));
  }
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = htmlAttribute(match[0], "href");
    if (/\.pdf(?:[?#]|$)|\/article\/download\/|\/download\//i.test(href)) links.push(href);
  }
  return [...new Set(links.filter(Boolean).map((value) => {
    try { return new URL(value.replaceAll("&amp;", "&"), baseUrl).toString(); }
    catch { return ""; }
  }).filter(Boolean))];
}

function markdownBlocks(markdown: string) {
  const blocks: string[] = [];
  let current: string[] = [];
  let inCodeFence = false;
  let inMathFence = false;
  let inStructuredBinding = false;
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const rawLine of markdown.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (/<!--ATLAS_BIND_(?:figure|table)-\d{3}-->/i.test(line)) inStructuredBinding = true;
    if (!inCodeFence && !inMathFence && !inStructuredBinding && !line) {
      flush();
      continue;
    }
    current.push(rawLine);
    if (line.startsWith("```")) inCodeFence = !inCodeFence;
    if (!inCodeFence && line === "$$") inMathFence = !inMathFence;
    if (/<!--ATLAS_BIND_END_(?:figure|table)-\d{3}-->/i.test(line)) inStructuredBinding = false;
  }
  flush();
  return blocks;
}

function atomicMarkdownBlock(block: string) {
  const trimmed = block.trim();
  return trimmed.includes("ATLAS_BIND_") || trimmed.startsWith("```") || trimmed.startsWith("$$") || trimmed.startsWith("|") || /^<table\b/i.test(trimmed) || /^!\[[^\]]*\]\(/.test(trimmed);
}

function splitOversizedBlock(block: string, maxChars: number) {
  if (block.length <= maxChars || atomicMarkdownBlock(block)) return [block];
  const units = block.split(/(?<=[.!?。！？])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  if (units.length <= 1) {
    const slices: string[] = [];
    for (let index = 0; index < block.length; index += maxChars) slices.push(block.slice(index, index + maxChars));
    return slices;
  }
  const slices: string[] = [];
  let current = "";
  for (const unit of units) {
    if (unit.length > maxChars) {
      if (current) { slices.push(current); current = ""; }
      for (let index = 0; index < unit.length; index += maxChars) slices.push(unit.slice(index, index + maxChars));
      continue;
    }
    if (current && current.length + unit.length + 1 > maxChars) { slices.push(current); current = ""; }
    current = current ? `${current} ${unit}` : unit;
  }
  if (current) slices.push(current);
  return slices;
}

function normalizedHeadingText(value: string) {
  return value.replace(/[*_`]/g, "").replace(/^\s*(?:appendix\s+)?(?:[ivxlcdm]+|[a-z]|\d+(?:\.\d+)*)[.)：:]?\s+/i, "").trim().toLocaleLowerCase().replace("qulitative", "qualitative");
}

function explicitHeadingDepth(value: string) {
  const plain = value.replace(/[*_`]/g, "").trim();
  const roman = plain.match(/^([IVXLCDM]+)[.)：:]\s+(.+)$/i);
  if (roman) return roman[1].length > 1 || primarySectionHeading(roman[2]) ? 2 : 3;
  if (/^[A-Z][.)：:]\s+/.test(plain)) return 3;
  const numeric = plain.match(/^(\d+(?:\.\d+)*)(?:[.)：:]|\s)\s*/);
  if (numeric) return Math.min(5, numeric[1].split(".").length + 1);
  return null;
}

function primarySectionHeading(value: string) {
  return /^(?:abstract|introduction|related works?|background|preliminaries|method|methodology|approach|experiments?|experimental setup|experimental results|evaluation|results?|discussion|limitations?|conclusions?(?: and future works?)?|future works?|references|bibliography|acknowledg(?:e)?ments|implementation details|dataset introduction|additional experimental results|additional qualitative results|supplementary material|appendix)$/.test(normalizedHeadingText(value));
}

function normalizeTableHeaders(markdown: string) {
  return markdown.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const headerLike = (row: string) => {
      const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      return cells.length > 0 && cells.length <= 16 && cells.every((cell) => cell.length <= 18 && /^(?:\d+s|Avg\.?|[A-Z][A-Za-z0-9 .()/%↓↑&-]*)$/u.test(cell));
    };
    let normalized = table;
    if (!/<th\b/i.test(normalized)) {
      normalized = normalized.replace(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/i, (_match, attributes: string, cells: string) => {
        const headerCells = cells.replace(/<td\b/gi, "<th").replace(/<\/td>/gi, "</th>");
        return `<thead><tr${attributes}>${headerCells}</tr></thead>`;
      });
    }
    const thead = normalized.match(/<thead\b[^>]*>[\s\S]*?<\/thead>/i);
    if (!thead) return normalized;
    const afterThead = normalized.slice((thead.index || 0) + thead[0].length);
    const firstLooseRow = afterThead.match(/^[\s\n]*(<tr\b[^>]*>[\s\S]*?<\/tr>)/i);
    if (!firstLooseRow || !headerLike(firstLooseRow[1])) return normalized;
    const promoted = firstLooseRow[1].replace(/<td\b/gi, "<th").replace(/<\/td>/gi, "</th>");
    const updatedThead = thead[0].replace(/<\/thead>$/i, `${promoted}</thead>`);
    return `${normalized.slice(0, thead.index || 0)}${updatedThead}${afterThead.slice(firstLooseRow[0].length)}`;
  });
}

function normalizeParserHtml(markdown: string) {
  let normalized = markdown.replace(/<div\b[^>]*>\s*(<img\b[^>]*>)\s*<\/div>/gi, (_match, imageTag: string) => {
    const src = htmlAttribute(imageTag, "src");
    const alt = htmlAttribute(imageTag, "alt") || "论文图表";
    return src ? `\n\n![${alt}](${src})\n\n` : "";
  });
  normalized = normalized.replace(/<img\b[^>]*>/gi, (imageTag) => {
    const src = htmlAttribute(imageTag, "src");
    const alt = htmlAttribute(imageTag, "alt") || "论文图表";
    return src ? `![${alt}](${src})` : "";
  });
  normalized = normalized.replace(/<div\b[^>]*>\s*((?:\*\*)?(?:Figure|Fig\.?|Table)\s*(?:\d+|[IVXLCDM]+)[\s\S]*?)\s*<\/div>/gi, "$1");
  return normalizeTableHeaders(normalized);
}

/**
 * Keep parser tables even when the source caption says Figure. A visual table
 * can legitimately be labelled as a figure in the paper, and deleting it here
 * loses the only source representation before semantic review can inspect it.
 */
function removeFigureTableSurrogates(markdown: string) {
  return markdown;
}

export type PaperAffiliation = { index: number; text: string };
export type PaperAuthorAffiliation = { name: string; affiliations: number[] };

function paperFrontMatter(markdown: string) {
  const lines = normalizeParserHtml(markdown).replace(/\r/g, "").trim().split("\n");
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s+/.test(line.trim()));
  return firstHeading > 0 ? lines.slice(0, firstHeading) : lines;
}

/** Read numbered affiliations from the parser's title/author front matter. */
export function extractPaperAffiliations(markdown: string, title: string): PaperAffiliation[] {
  const frontMatter = paperFrontMatter(markdown);
  const affiliations: PaperAffiliation[] = [];
  for (const line of frontMatter) {
    const cleaned = line.replace(/\$/g, "").replace(/[{}]/g, "").replace(/\\\^/g, "^").trim();
    const match = cleaned.match(/^\^?(\d+)\s+(.+)$/);
    if (!match || normalizedHeadingText(match[2]) === normalizedHeadingText(title)) continue;
    const index = Number(match[1]);
    const text = match[2].replace(/\s{2,}/g, " ").trim();
    if (text && !affiliations.some((item) => item.index === index && item.text === text)) affiliations.push({ index, text });
  }
  return affiliations;
}

/** Match each author to the numbered affiliations printed in the PDF front matter. */
export function extractPaperAuthorAffiliations(markdown: string): PaperAuthorAffiliation[] {
  const frontMatter = paperFrontMatter(markdown);
  const authorLine = frontMatter.find((line) => {
    const markerCount = (line.match(/\^\{[^}]+\}/g) || []).length;
    return markerCount >= 2 && !/^\s*\$?\s*\^\{?\d/.test(line);
  })?.replace(/\s+/g, " ") || "";
  const entries: PaperAuthorAffiliation[] = [];
  const pattern = /([^,]+?)\s*(?:\^\{([^}]+)\}|<sup>([^<]+)<\/sup>)/gi;
  for (const match of authorLine.matchAll(pattern)) {
    const name = match[1].replace(/[ $]+$/g, "").trim();
    const markerText = match[2] || match[3] || "";
    const affiliations = [...markerText.matchAll(/\d+/g)].map((item) => Number(item[0])).filter((item, index, values) => values.indexOf(item) === index);
    if (name && affiliations.length && !entries.some((entry) => entry.name === name)) entries.push({ name, affiliations });
  }
  return entries;
}

function normalizeCaptionPlacement(markdown: string) {
  // Keep the parser's original order until the binding manifest is resolved.
  // Moving captions here can make a caption from a later table appear to belong
  // to an earlier object. `normalizeBoundCaptionPlacement` is the only stage
  // allowed to place captions after stable IDs and semantic kinds are known.
  return markdown;
}

type CaptionKind = "figure" | "table";
type CaptionEntry = { kind: CaptionKind; number: number };

const CAPTION_NUMBER_PATTERN = String.raw`(?:\d+|[IVXLCDM]+|\$[IVXLCDM]+\$)`;
const captionLabelPattern = new RegExp(`(^|\\n|>\\s*)(\\*\\*)?(Figure|Fig\\.?|Table|图|表)\\s*(${CAPTION_NUMBER_PATTERN})\\s*([:：-])`, "gim");

function captionNumberValue(value: string) {
  value = value.replace(/\$/g, "");
  if (/^\d+$/.test(value)) return Number(value);
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let previous = 0;
  for (const symbol of value.toUpperCase().split("").reverse()) {
    const current = values[symbol] || 0;
    total += current < previous ? -current : current;
    previous = Math.max(previous, current);
  }
  return total || Number(value);
}

function captionSequence(markdown: string): CaptionEntry[] {
  return [...markdown.matchAll(captionLabelPattern)].map((match) => ({
    kind: /^(?:Figure|Fig\.?|图)$/i.test(match[3]) ? "figure" : "table",
    number: captionNumberValue(match[4]),
  }));
}

/** Restore figure/table labels and numbering from the source document order. */
export function restoreCaptionSequence(source: string, translated: string) {
  const expected = captionSequence(source);
  const actual = [...translated.matchAll(captionLabelPattern)];
  if (!expected.length || expected.length !== actual.length) return translated;
  let index = 0;
  return translated.replace(captionLabelPattern, (_match, prefix: string, emphasis: string | undefined, _kind: string, _number: string, separator: string) => {
    const caption = expected[index++];
    return `${prefix}${emphasis || ""}${caption.kind === "figure" ? "图" : "表"} ${caption.number}${separator}`;
  });
}

export type StructuredBindingKind = CaptionKind | "table_image";
export type StructuredBindingObject = {
  id: string;
  kind: StructuredBindingKind;
  start: number;
  end: number;
  text: string;
  asset?: string;
  captionId?: string;
  captionKind?: CaptionKind;
  captionNumber?: number;
  captionText?: string;
  distance?: number;
  ambiguous: boolean;
};
export type StructuredBindingCaption = {
  id: string;
  kind: CaptionKind;
  number: number;
  start: number;
  end: number;
  text: string;
};
export type StructuredBindingManifest = {
  objects: StructuredBindingObject[];
  captions: StructuredBindingCaption[];
  ambiguous: string[];
};

export type DocumentBlock =
  | { id: string; type: "heading"; depth: number; text: string }
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "formula"; text: string }
  | { id: string; type: "figure" | "native_table" | "table_image"; objectId: string; asset?: string }
  | { id: string; type: "caption"; captionId: string; kind: CaptionKind; number: number; text: string };

export type DocumentIR = {
  version: 1;
  blocks: DocumentBlock[];
  bindings: StructuredBindingManifest;
};

/** Build a lightweight intermediate representation used for validation and debugging. */
export function buildDocumentIR(markdown: string, bindings: StructuredBindingManifest): DocumentIR {
  const blocks: DocumentBlock[] = [];
  for (const match of markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    blocks.push({ id: `heading-${blocks.length + 1}`, type: "heading", depth: match[1].length, text: match[2].trim() });
  }
  for (const object of bindings.objects) {
    blocks.push({ id: object.id, type: object.kind === "table" ? "native_table" : object.kind === "table_image" ? "table_image" : "figure", objectId: object.id, asset: object.asset });
  }
  for (const caption of bindings.captions) {
    blocks.push({ id: caption.id, type: "caption", captionId: caption.id, kind: caption.kind, number: caption.number, text: caption.text });
  }
  blocks.sort((left, right) => {
    const position = (block: DocumentBlock) => {
      if (block.type === "heading") return markdown.indexOf(block.text);
      if (block.type === "caption") return markdown.indexOf(block.text);
      if (block.type === "paragraph" || block.type === "formula") return markdown.indexOf(block.text);
      const object = bindings.objects.find((item) => item.id === block.objectId);
      return object?.start ?? Number.MAX_SAFE_INTEGER;
    };
    return position(left) - position(right);
  });
  return { version: 1, blocks, bindings };
}

function structuredObjectMatches(markdown: string) {
  const pattern = /<table\b[\s\S]*?<\/table>|!\[[^\]]*\]\(([^)\n]+)\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const raw = [...markdown.matchAll(pattern)].map((match) => {
    const text = match[0];
    const kind: StructuredBindingKind = /^<table\b/i.test(text) ? "table" : "figure";
    const asset = kind === "figure" ? (match[1] || match[2]) : undefined;
    return { start: match.index ?? 0, end: (match.index ?? 0) + text.length, text, kind, asset };
  });
  const grouped: typeof raw = [];
  for (const item of raw) {
    const previous = grouped.at(-1);
    const assetBounds = (asset?: string) => asset?.match(/assets\/page-(\d+)-\d+-img_in_image_box_(\d+)_(\d+)_(\d+)_(\d+)/i);
    const previousBounds = assetBounds(previous?.asset);
    const currentBounds = assetBounds(item.asset);
    const horizontallyAdjacent = Boolean(previousBounds && currentBounds
      && previousBounds[1] === currentBounds[1]
      && Math.abs(Number(previousBounds[3]) - Number(currentBounds[3])) <= 120
      && Math.abs(Number(previousBounds[2]) - Number(currentBounds[2])) >= 200);
    if (previous?.kind === "figure" && item.kind === "figure" && horizontallyAdjacent && /^\s*$/.test(markdown.slice(previous.end, item.start))) {
      previous.end = item.end;
      previous.text = markdown.slice(previous.start, item.end);
      continue;
    }
    grouped.push({ ...item });
  }
  return grouped;
}

function structuredCaptionMatches(markdown: string) {
  return [...markdown.matchAll(captionLabelPattern)].map((match, index) => ({
    id: `caption-${String(index + 1).padStart(3, "0")}`,
    kind: /^(?:Figure|Fig\.?|图)$/i.test(match[3]) ? "figure" as const : "table" as const,
    number: captionNumberValue(match[4]),
    start: (match.index ?? 0) + (match[1]?.length || 0),
    end: (() => {
      const lineEnd = markdown.indexOf("\n", (match.index ?? 0) + (match[1]?.length || 0));
      return lineEnd < 0 ? markdown.length : lineEnd;
    })(),
    text: markdown.slice(match.index ?? 0, (() => {
      const lineEnd = markdown.indexOf("\n", (match.index ?? 0) + (match[1]?.length || 0));
      return lineEnd < 0 ? markdown.length : lineEnd;
    })()).replace(/^>\s*/, "").trim(),
  }));
}

/**
 * Build a cheap, deterministic object↔caption manifest before translation.
 * It uses layout order and direction (table caption above, figure caption below),
 * then exposes only ambiguous records to the optional semantic reviewer.
 */
export function buildStructuredBindingManifest(markdown: string): StructuredBindingManifest {
  const objects = structuredObjectMatches(markdown);
  const captions = structuredCaptionMatches(markdown);
  const usedCaptions = new Set<string>();
  const manifestObjects: StructuredBindingObject[] = [];
  const ambiguous: string[] = [];
  const counters: Record<"figure" | "table", number> = { figure: 0, table: 0 };

  for (const object of objects) {
    counters[object.kind] += 1;
    const id = `${object.kind}-${String(counters[object.kind]).padStart(3, "0")}`;
    const directionalCandidates = captions
      .filter((caption) => !usedCaptions.has(caption.id))
      .map((caption) => {
        const isDirectional = object.kind === "figure" ? caption.start >= object.end : caption.end <= object.start;
        const sameKind = caption.kind === object.kind;
        const distance = caption.start >= object.end ? caption.start - object.end : object.start - caption.end;
        return { caption, distance, isDirectional, sameKind, score: Math.max(0, distance) };
      })
      .filter((candidate) => candidate.isDirectional && candidate.distance <= 1800)
      .sort((left, right) => left.score - right.score);
    const fallbackCandidates = captions
      .filter((caption) => !usedCaptions.has(caption.id))
      .map((caption) => {
        const isDirectional = object.kind === "figure" ? caption.start >= object.end : caption.end <= object.start;
        const distance = caption.start >= object.end ? caption.start - object.end : object.start - caption.end;
        return { caption, distance, isDirectional, sameKind: caption.kind === object.kind, score: Math.max(0, distance) };
      })
      .filter((candidate) => candidate.distance <= 1800)
      .sort((left, right) => left.score - right.score);
    const selected = directionalCandidates[0] || fallbackCandidates[0];
    const record: StructuredBindingObject = {
      id,
      kind: object.kind,
      start: object.start,
      end: object.end,
      text: object.text,
      asset: object.asset,
      captionId: selected?.caption.id,
      captionKind: selected?.caption.kind,
      captionNumber: selected?.caption.number,
      captionText: selected?.caption.text,
      distance: selected?.distance,
      // Without captions there is nothing to bind: the parser's intrinsic
      // kind (HTML table vs image) is authoritative and must not block the
      // paper waiting for a semantic reviewer.
      ambiguous: captions.length === 0
        ? false
        : !selected || !selected.isDirectional || selected.caption.kind !== object.kind || selected.distance > 1800,
    };
    if (selected) usedCaptions.add(selected.caption.id);
    if (record.ambiguous) ambiguous.push(id);
    manifestObjects.push(record);
  }

  for (const caption of captions) if (!usedCaptions.has(caption.id)) ambiguous.push(caption.id);
  return { objects: manifestObjects, captions, ambiguous: [...new Set(ambiguous)] };
}

export type SemanticBindingDecision = {
  id: string;
  semantic_kind: "figure" | "table" | "table_image" | "unknown";
  caption_id?: string | null;
  confidence: number;
  reason: string;
};

/** Apply a semantic decision to the binding manifest before fences are written. */
export function applySemanticBindingDecisions(manifest: StructuredBindingManifest, decisions: SemanticBindingDecision[]) {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const changed = new Set<string>();
  for (const object of manifest.objects) {
    const decision = byId.get(object.id);
    if (!decision || decision.semantic_kind === "unknown" || decision.confidence < 0.65) continue;
    object.kind = decision.semantic_kind;
    object.captionId = undefined;
    object.captionKind = undefined;
    object.captionNumber = undefined;
    object.captionText = undefined;
    object.distance = undefined;
    object.ambiguous = true;
    changed.add(object.id);
  }

  // A parser run that produced zero captions has nothing to bind; a confident
  // semantic decision (figure vs table) is then sufficient to publish. Without
  // this branch, every object would remain ambiguous and block the paper.
  if (changed.size > 0 && manifest.captions.length === 0) {
    for (const object of manifest.objects) {
      if (changed.has(object.id)) object.ambiguous = false;
    }
    manifest.ambiguous = manifest.objects.filter((object) => object.ambiguous).map((object) => object.id);
    return manifest;
  }

  // When semantic review covered the document and the parser produced a
  // one-to-one object/caption sequence, source order is a safer binding than
  // model-provided caption IDs. This handles OCR labels such as Figure 1 on a
  // native table without letting a later Table caption get stolen.
  if (changed.size > 0 && manifest.objects.length === manifest.captions.length) {
    const orderedObjects = [...manifest.objects].sort((left, right) => left.start - right.start);
    const orderedCaptions = [...manifest.captions].sort((left, right) => left.start - right.start);
    const mismatchCount = orderedObjects.reduce((count, object, index) => {
      const expectedKind = object.kind === "figure" ? "figure" : "table";
      return count + (orderedCaptions[index].kind === expectedKind ? 0 : 1);
    }, 0);
    if (mismatchCount <= Math.max(2, Math.floor(orderedObjects.length * 0.15))) {
      orderedObjects.forEach((object, index) => {
        const caption = orderedCaptions[index];
        object.captionId = caption.id;
        object.captionKind = caption.kind;
        object.captionNumber = caption.number;
        object.captionText = caption.text;
        object.distance = Math.abs(caption.start - object.end);
        object.ambiguous = false;
      });
      manifest.ambiguous = [];
      return manifest;
    }
  }

  const usedCaptions = new Set(manifest.objects.filter((object) => !changed.has(object.id) && object.captionId).map((object) => object.captionId!));
  for (const object of manifest.objects.filter((item) => changed.has(item.id)).sort((left, right) => left.start - right.start)) {
    const decision = byId.get(object.id)!;
    const requestedCaption = decision.caption_id && manifest.captions.find((caption) => caption.id === decision.caption_id);
    const expectedKind = object.kind === "table" || object.kind === "table_image" ? "table" : "figure";
    const shouldBeBefore = object.kind === "table";
    const candidate = requestedCaption && !usedCaptions.has(requestedCaption.id)
      ? requestedCaption
      : manifest.captions
        .filter((caption) => caption.kind === expectedKind && !usedCaptions.has(caption.id))
        .map((caption) => ({ caption, distance: caption.start >= object.end ? caption.start - object.end : object.start - caption.end, directional: shouldBeBefore ? caption.end <= object.start : caption.start >= object.end }))
        .filter((item) => item.directional && item.distance <= 4000)
        .sort((left, right) => left.distance - right.distance)[0]?.caption;
    if (candidate) {
      object.captionId = candidate.id;
      object.captionKind = candidate.kind;
      object.captionNumber = candidate.number;
      object.captionText = candidate.text;
      object.distance = candidate.start >= object.end ? candidate.start - object.end : object.start - candidate.end;
      object.ambiguous = false;
      usedCaptions.add(candidate.id);
    }
  }

  manifest.ambiguous = [
    ...manifest.objects.filter((object) => object.ambiguous).map((object) => object.id),
    ...manifest.captions.filter((caption) => !usedCaptions.has(caption.id)).map((caption) => caption.id),
  ];
  return manifest;
}

/** Place a caption exactly once after semantic binding has been resolved. */
export function normalizeBoundCaptionPlacement(markdown: string, manifest: StructuredBindingManifest) {
  let result = markdown;
  for (const object of [...manifest.objects].sort((left, right) => Math.max(right.start, right.end) - Math.max(left.start, left.end))) {
    if (!object.captionId) continue;
    const caption = manifest.captions.find((item) => item.id === object.captionId);
    if (!caption) continue;
    const captionBefore = caption.start < object.start;
    const shouldBeBefore = object.kind === "table";
    if (captionBefore === shouldBeBefore) continue;
    const captionText = result.slice(caption.start, caption.end).trim();
    const objectText = result.slice(object.start, object.end).trim();
    if (!captionText || !objectText) continue;
    if (shouldBeBefore) {
      result = `${result.slice(0, object.start)}${captionText}\n\n${objectText}${result.slice(object.end, caption.start)}${result.slice(caption.end)}`;
    } else {
      result = `${result.slice(0, caption.start)}${result.slice(caption.end, object.start)}${objectText}\n\n${captionText}${result.slice(object.end)}`;
    }
  }
  return result;
}

/** Add hidden, protected binding fences so a table/image and its caption stay atomic. */
export function annotateStructuredBindings(markdown: string, manifest: StructuredBindingManifest) {
  const clean = stripStructuredBindingMarkers(markdown);
  const edits: Array<{ index: number; value: string }> = [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const object of manifest.objects) {
    const caption = object.captionId ? manifest.captions.find((item) => item.id === object.captionId) : undefined;
    const spanStart = Math.min(object.start, caption?.start ?? object.start);
    const candidateEnd = Math.max(object.end, caption?.end ?? object.end);
    const otherObjects = structuredObjectMatches(clean).filter((item) => item.start >= spanStart && item.end <= candidateEnd && !(item.start === object.start && item.end === object.end));
    const otherCaptions = structuredCaptionMatches(clean).filter((item) => item.start >= spanStart && item.end <= candidateEnd && item.id !== object.captionId);
    const spanEnd = otherObjects.length || otherCaptions.length ? object.end : candidateEnd;
    if (ranges.some((range) => spanStart < range.end && spanEnd > range.start)) continue;
    ranges.push({ start: spanStart, end: spanEnd });
    const marker = `<!--ATLAS_BIND_${object.id}-->`;
    const endMarker = `<!--ATLAS_BIND_END_${object.id}-->`;
    edits.push({ index: spanStart, value: marker });
    edits.push({ index: spanEnd, value: endMarker });
  }
  return edits.sort((left, right) => right.index - left.index).reduce((result, edit) => `${result.slice(0, edit.index)}${edit.value}${result.slice(edit.index)}`, clean);
}

export function stripStructuredBindingMarkers(markdown: string) {
  return markdown.replace(/<!--ATLAS_BIND_(?:END_)?(?:figure|table|table_image)-\d{3}-->/gi, "");
}

function structuredWrappers(markdown: string) {
  const pattern = /<!--ATLAS_BIND_(figure|table|table_image)-(\d{3})-->([\s\S]*?)<!--ATLAS_BIND_END_\1-\2-->/gi;
  return [...markdown.matchAll(pattern)].map((match) => ({
    id: `${match[1].toLowerCase()}-${match[2]}`,
    kind: match[1].toLowerCase() as StructuredBindingKind,
    text: match[3],
  }));
}

/** Fail closed when a model moves a caption to another visual object. */
export function validateStructuredBindings(source: string, translated: string) {
  const issues: string[] = [];
  const sourceWrappers = structuredWrappers(source);
  const translatedWrappers = structuredWrappers(translated);
  if (sourceWrappers.length !== translatedWrappers.length) {
    issues.push(`图表绑定块数量不一致：原文 ${sourceWrappers.length}，译文 ${translatedWrappers.length}`);
    return issues;
  }
  sourceWrappers.forEach((sourceWrapper, index) => {
    const translatedWrapper = translatedWrappers[index];
    if (!translatedWrapper || sourceWrapper.id !== translatedWrapper.id || sourceWrapper.kind !== translatedWrapper.kind) {
      issues.push(`图表绑定块顺序或类型不一致：第 ${index + 1} 个对象`);
      return;
    }
    const sourceObjects = structuredObjectMatches(sourceWrapper.text);
    const translatedObjects = structuredObjectMatches(translatedWrapper.text);
    if (sourceObjects.length !== 1 || translatedObjects.length !== 1 || sourceObjects[0].kind !== translatedObjects[0].kind) {
      issues.push(`图表绑定块 ${sourceWrapper.id} 的对象类型或数量不一致`);
    }
    const sourceCaptions = structuredCaptionMatches(sourceWrapper.text);
    const translatedCaptions = structuredCaptionMatches(translatedWrapper.text);
    if (sourceCaptions.length !== translatedCaptions.length || sourceCaptions.some((caption, captionIndex) => caption.kind !== translatedCaptions[captionIndex]?.kind || caption.number !== translatedCaptions[captionIndex]?.number)) {
      issues.push(`图表绑定块 ${sourceWrapper.id} 的题注类型或编号不一致`);
    }
  });
  return [...new Set(issues)];
}

function normalizeMathBody(value: string) {
  const textBlocks: string[] = [];
  let body = value.replace(/\u00a0/g, " ").replace(/\\\s+/g, "\\");
  body = body.replace(/&\s*(if\b[^&\\]+)/gi, (_match, text: string) => `&\\text{${text.trim()}}`);
  body = body.replace(/\\text\{[^{}]*\}/g, (text) => {
    textBlocks.push(text);
    return `@@ATLAS_TEXT_${textBlocks.length - 1}@@`;
  });
  body = body.replace(/\\(sf|rm|bf|it)\s+((?:[A-Za-z]\s+)+[A-Za-z])(?=[^A-Za-z]|$)/g, (_match, style: string, identifier: string) => `\\math${style}{${identifier.replace(/\s+/g, "")}}`);
  body = body.replace(/\\(sf|rm|bf|it)\s*([A-Za-z]+)/g, (_match, style: string, identifier: string) => `\\math${style}{${identifier}}`);
  body = body.replace(/\\(theta|pi|mu|sigma|lambda|alpha|beta|gamma|varepsilon|epsilon|rho|tau|phi|psi|omega)(old|ref|new|target|path|traj)/gi, (_match, command: string, suffix: string) => `\\${command}_{${suffix}}`);
  body = body.replace(/\\(theta|pi|mu|sigma|lambda|alpha|beta|gamma|varepsilon|epsilon|rho|tau|phi|psi|omega|Delta|Sigma)\s+((?:[A-Za-z]\s+)+[A-Za-z])(?=[^A-Za-z]|$)/g, (_match, command: string, identifier: string) => `\\${command}_{${identifier.replace(/\s+/g, "")}}`);
  body = body.replace(/\\([A-Za-z]+)\s+((?:[A-Za-z]\s+)+[A-Za-z])(?=[^A-Za-z]|$)/g, (_match, command: string, identifier: string) => `\\${command}${identifier.replace(/\s+/g, "")}`);
  body = body.replace(/\\(mathrm|mathbf|mathcal|mathbb|mathsf|mathtt|mathit|boldsymbol|operatorname)\{([^{}]*)\}/g, (_match, command: string, content: string) => `\\${command}{${content.replace(/\s+/g, "")}}`);
  body = body.replace(/\{([A-Za-z](?:\s+[A-Za-z])+)\}/g, (_match, content: string) => `{${content.replace(/\s+/g, "")}}`);
  body = body.replace(/([A-Za-z](?:\s+[A-Za-z]){2,})(?=[^A-Za-z]|$)/g, (identifier) => identifier.replace(/\s+/g, ""));
  body = body.replace(/([A-Za-z])_\{(\\(?:mathsf|mathrm|mathbf|mathcal|mathbb)\{[^{}]*\}|[^{}]*)\}_\{([^{}]*)\}/g, (_match, base: string, first: string, second: string) => `${base}_{${first}_{${second}}}`);
  body = body.replace(/([A-Za-z])_\{([^{}]*)\}_\{([^{}]*)\}/g, (_match, base: string, first: string, second: string) => `${base}_{${first}_${second}}`);
  body = body.replace(/\s{2,}/g, " ").trim();
  return body.replace(/@@ATLAS_TEXT_(\d+)@@/g, (_match, index: string) => textBlocks[Number(index)]);
}

function normalizeMathExpressions(markdown: string) {
  return markdown.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([^\n]+\\\)|(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)/g, (expression) => {
    if (expression.startsWith("$$")) {
      const body = normalizeMathBody(expression.slice(2, -2));
      return /\n/.test(expression) ? `$$\n${body}\n$$` : `$$${body}$$`;
    }
    if (expression.startsWith("\\[")) return `\\[${normalizeMathBody(expression.slice(2, -2))}\\]`;
    if (expression.startsWith("\\(")) return `\\(${normalizeMathBody(expression.slice(2, -2))}\\)`;
    return `$${normalizeMathBody(expression.slice(1, -1))}$`;
  });
}

function removeParserPageSeparators(markdown: string) {
  return markdown.replace(/^\s*---\s*$/gm, "");
}

function normalizeInlineVariables(markdown: string) {
  const protectedTokens: string[] = [];
  const protect = (value: string) => {
    const token = `@@ATLAS_INLINE_${protectedTokens.length}@@`;
    protectedTokens.push(value);
    return token;
  };
  let text = markdown.replace(/<table\b[\s\S]*?<\/table>|<[^>]*>|\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\n]+\$(?!\$)/gi, protect);
  text = text
    .replace(/((?:参数|变量|时间步|组数|迭代次数|维度|第)\s*)([A-Za-z])\b/g, (_match, prefix: string, variable: string) => `${prefix}$${variable}$`)
    .replace(/\b([A-Za-z])\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/g, (_match, variable: string, value: string) => `$${variable} = ${value}$`)
    .replace(/([\u4e00-\u9fff（(])\s*([A-Za-z])(?=\s*(?:个|次|米|秒|步|点))/g, (_match, prefix: string, variable: string) => `${prefix}$${variable}$`)
    .replace(/([\u4e00-\u9fff，。；：、,;:（(])\s*([A-Za-z])(?=\s*[\u4e00-\u9fff，。；：、,;:）)])/g, (_match, prefix: string, variable: string) => `${prefix}$${variable}$`);
  return text.replace(/@@ATLAS_INLINE_(\d+)@@/g, (_match, index: string) => protectedTokens[Number(index)]);
}

/** Convert a references section into a real ordered Markdown list. */
export function numberReferenceSection(markdown: string) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const output = [...lines];
  const headingIndex = lines.findIndex((line) => {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    return Boolean(match && /^(?:references?|bibliography|参考文献)$/.test(normalizedHeadingText(match[1])));
  });
  if (headingIndex < 0) return markdown;
  const endIndex = lines.findIndex((line, index) => index > headingIndex && /^#{1,6}\s+/.test(line));
  const sectionEnd = endIndex < 0 ? lines.length : endIndex;
  const sectionText = lines.slice(headingIndex + 1, sectionEnd).join("\n").trim();
  const existingMarkers = [...sectionText.matchAll(/(?:^|\s)(\d{1,3})\.\s+(?=[A-Z\u4e00-\u9fff])/g)];
  if (existingMarkers.length >= 2) {
    const entries = existingMarkers.map((marker, index) => sectionText.slice(marker.index! + (marker[0].startsWith(" ") ? 1 : 0), existingMarkers[index + 1]?.index ?? sectionText.length).trim()).filter((entry) => !/^\d+\.\s*补充材料\s*$/u.test(entry));
    return [...lines.slice(0, headingIndex + 1), "", ...entries.map((entry, index) => `${index + 1}. ${entry.replace(/^\d+\.\s*/, "")}`), ...lines.slice(sectionEnd)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const blocks: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.some((line) => line.trim())) blocks.push(current);
    current = [];
  };
  for (const line of lines.slice(headingIndex + 1, sectionEnd)) {
    if (!line.trim()) flush();
    else current.push(line.trim());
  }
  flush();
  if (!blocks.length) return markdown;
  const numbered = blocks.map((block, index) => {
    const value = block.join(" ").replace(/^\s*(?:\d+[.)]|\[\d+\])\s*/, "").trim();
    return `${index + 1}. ${value}`;
  });
  return [...lines.slice(0, headingIndex + 1), "", ...numbered, ...lines.slice(sectionEnd)].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function prepareTranslationSource(markdown: string, title: string) {
  const normalizedTitle = normalizedHeadingText(title);
  const normalized = normalizeInlineVariables(removeParserPageSeparators(normalizeCaptionPlacement(normalizeMathExpressions(removeFigureTableSurrogates(normalizeParserHtml(markdown))))));
  const lines = normalized.replace(/\r/g, "").trim().split("\n");
  const firstBodyHeading = lines.findIndex((line) => {
    const heading = line.trim().match(/^(#{1,6})\s+(.+)$/);
    return Boolean(heading && (primarySectionHeading(heading[2]) || heading[1].length >= 2));
  });
  const bodyLines = firstBodyHeading > 0 ? lines.slice(firstBodyHeading) : lines;
  const structuredLines = bodyLines.flatMap((line) => {
    const heading = line.trim().match(/^(#{1,6})\s+(.+)$/);
    if (!heading) return [line];
    const headingText = heading[2].trim();
    if (normalizedHeadingText(headingText) === normalizedTitle) return [];
    const numberedDepth = explicitHeadingDepth(headingText);
    if (numberedDepth) return [`${"#".repeat(numberedDepth)} ${headingText}`];
    if (heading[1].length === 1 || primarySectionHeading(headingText)) return [`## ${headingText}`];
    if (heading[1].length >= 3) return [`#### ${headingText}`];
    return [`### ${headingText}`];
  });
  return structuredLines.join("\n")
    .replace(/^\s+/, "")
    .replace(/^\s*---\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitTranslationChunks(text: string, maxChars = 9000) {
  const blocks = markdownBlocks(text);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks.flatMap((item) => splitOversizedBlock(item, maxChars))) {
    const startsSection = /^#{1,6}\s+/.test(block);
    if (startsSection && current) { chunks.push(current); current = ""; }
    if (current && current.length + block.length + 2 > maxChars) { chunks.push(current); current = ""; }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) chunks.push(current);
  return chunks;
}

type ProtectedToken = { token: string; value: string };

/**
 * Protect structured assets and equations while DeepSeek translates prose.
 * The parser owns these values; the model must not rewrite paths or LaTeX.
 */
export function protectStructuredMarkdown(markdown: string) {
  const protectedTokens: ProtectedToken[] = [];
  const protect = (value: string, kind: string) => {
    const token = `[[ATLAS_${kind}_${String(protectedTokens.length).padStart(6, "0")}]]`;
    protectedTokens.push({ token, value });
    return token;
  };

  let text = markdown.replace(/<!--ATLAS_BIND_(?:END_)?(?:figure|table|table_image)-\d{3}-->/gi, (value) => protect(value, "BIND"));
  text = text.replace(/<table\b[\s\S]*?<\/table>/gi, (value) => protect(value, "TABLE"));
  text = text.replace(/<div\b[^>]*>\s*<img\b[^>]*>\s*<\/div>|<img\b[^>]*>/gi, (value) => protect(value, "ASSET"));
  text = text.replace(/!\[[^\]]*\]\([^\)]+\)/g, (value) => protect(value, "ASSET"));
  text = text.replace(captionLabelPattern, (value, prefix: string, emphasis: string | undefined, kind: string, number: string, separator: string) => {
    const label = /^(?:Figure|Fig\.?|图)$/i.test(kind) ? "图" : "表";
    return `${prefix || ""}${protect(`${emphasis || ""}${label} ${number}${separator}`, "CAPTION")}`;
  });
  text = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]+\$|\\\([^\n]+\\\)/g, (value) => protect(value, "MATH"));
  return { text, protectedTokens };
}

export function restoreStructuredMarkdown(markdown: string, protectedTokens: ProtectedToken[]) {
  return [...protectedTokens].sort((left, right) => right.token.length - left.token.length).reduce((result, item) => result.replaceAll(item.token, () => item.value), markdown);
}

function figureNumberAround(markdown: string, start: number) {
  const before = markdown.slice(Math.max(0, start - 500), start);
  const previousMatch = [...before.matchAll(/\b(?:Fig\.?|Figure)\s*(\d+)\b/gi)].at(-1);
  if (previousMatch) return Number(previousMatch[1]);
  const after = markdown.slice(start, start + 500);
  const nextMatch = after.match(/\b(?:Fig\.?|Figure)\s*(\d+)\b/i);
  const match = nextMatch;
  return match ? Number(match[1]) : null;
}

/** Rebuild image placement from the parser output after translation. */
export function restoreImageLayout(source: string, translated: string) {
  const sourceImages: Array<{ path: string; figureNumber: number | null }> = [];
  const imagePattern = /!\[[^\]]*\]\((assets\/[^)]+)\)/g;
  for (const match of source.matchAll(imagePattern)) {
    sourceImages.push({ path: match[1], figureNumber: figureNumberAround(source, match.index ?? 0) });
  }
  if (!sourceImages.length) return translated;

  const lines = translated.replace(imagePattern, "").split("\n");
  const insertions = new Map<number, string[]>();
  const figureLines = new Map<number, number>();
  for (const image of sourceImages) {
    let lineIndex = -1;
    if (image.figureNumber !== null) {
      lineIndex = figureLines.get(image.figureNumber) ?? lines.findIndex((line) => new RegExp(`(?:图|Fig\\.?|Figure)\\s*${image.figureNumber}\\s*[:：]`, "i").test(line));
      if (lineIndex >= 0) figureLines.set(image.figureNumber, lineIndex);
    }
    if (lineIndex < 0) lineIndex = lines.length - 1;
    insertions.set(lineIndex, [...(insertions.get(lineIndex) || []), `![Image](${image.path})`]);
  }
  return lines.flatMap((line, index) => [line, ...(insertions.get(index) || []), ""]).join("\n").replace(/\n{3,}/g, "\n\n");
}

function markdownHeadings(markdown: string) {
  return [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({ depth: match[1].length, text: match[2].trim() }));
}

/** Force translated headings back to the parser-normalized hierarchy by sequence. */
export function restoreHeadingLayout(source: string, translated: string) {
  const sourceHeadings = markdownHeadings(source);
  const translatedHeadings = markdownHeadings(translated);
  if (sourceHeadings.length !== translatedHeadings.length) return translated;
  let index = 0;
  return translated.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _marks: string, text: string) => `${"#".repeat(sourceHeadings[index++].depth)} ${text.trim()}`);
}

/**
 * Parser output sometimes misses numbered section lead-ins ("5. Cognition Is
 * for Action") while the model promotes them to headings. When the source has
 * a "## N." numbering pattern, demote translated "## N." headings that do not
 * exist in the source back to bold paragraphs, so the translated structure
 * stays source-faithful.
 */
export function normalizeExtraNumberedHeadings(source: string, translated: string) {
  const sourceNumbered = new Set(
    [...source.matchAll(/^##\s+(\d+)\.\s+/gm)].map((match) => match[1]),
  );
  if (!sourceNumbered.size) return translated;
  return translated.replace(/^##\s+(\d+)\.\s+(.+)$/gm, (match, number: string, text: string) =>
    sourceNumbered.has(number) ? match : `**${number}. ${text}**`,
  );
}

function markdownImages(markdown: string) {
  return [
    ...[...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]),
    ...[...markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]),
  ].sort();
}

function mathExpressions(markdown: string) {
  return [...markdown.matchAll(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([^\n]+\\\)|(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)/g)].map((match) => canonicalMathExpression(match[0]));
}

/** Compare formulas independently of harmless whitespace around delimiters. */
function canonicalMathExpression(expression: string) {
  const compact = expression.replace(/\s+/g, " ").trim();
  const normalizeBody = (body: string) => normalizeMathBody(body).replace(/\s+/g, " ").trim();
  if (compact.startsWith("$$") && compact.endsWith("$$")) return `$$${normalizeBody(compact.slice(2, -2))}$$`;
  if (compact.startsWith("\\[") && compact.endsWith("\\]")) return `\\[${normalizeBody(compact.slice(2, -2))}\\]`;
  if (compact.startsWith("\\(") && compact.endsWith("\\)")) return `\\(${normalizeBody(compact.slice(2, -2))}\\)`;
  if (compact.startsWith("$") && compact.endsWith("$")) return `$${normalizeBody(compact.slice(1, -1))}$`;
  return compact;
}

function inlineMathBody(expression: string) {
  if (expression.startsWith("$$") || expression.startsWith("\\[") || expression.startsWith("\\(")) return "";
  return expression.slice(1, -1).replace(/\s+/g, "").trim();
}

function isSimpleInlineVariable(expression: string) {
  const body = inlineMathBody(expression);
  return Boolean(body && /^(?:[A-Za-z]|\\[A-Za-z]+|\\(?:mathcal|mathbf|mathrm|mathbb)\{[A-Za-z]\})(?:_(?:\{[^{}]+\}|[A-Za-z0-9]+))?(?:\^(?:\{[^{}]+\}|[A-Za-z0-9]+))?(?:=\-?[A-Za-z0-9.]+)?$/.test(body));
}

function sourceContainsBareVariable(source: string, expression: string) {
  const body = inlineMathBody(expression).replace(/\\[A-Za-z]+/g, "").replace(/[{}_^]/g, "").trim();
  if (!body || body.length > 8) return false;
  const sourceText = source.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([^\n]+\\\)|(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)/g, " ");
  const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The source may already have the same variable inside a protected formula;
  // accept that as evidence when DeepSeek adds the required inline wrapper in
  // nearby prose. Complex or multi-character invented formulas remain strict.
  const compactSource = sourceText.replace(/\s+/g, "");
  const compactBody = body.replace(/\s+/g, "");
  return new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`).test(sourceText)
    || new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`).test(source)
    || compactSource.includes(compactBody);
}

/** Compare formulas while allowing the mandated $b$/$T$ wrappers around bare variables. */
function mathContentEquivalent(source: string, translated: string) {
  const remaining = [...mathExpressions(source)];
  const extras: string[] = [];
  for (const expression of mathExpressions(translated)) {
    const matchIndex = remaining.indexOf(expression);
    if (matchIndex >= 0) remaining.splice(matchIndex, 1);
    else if (!(isSimpleInlineVariable(expression) && sourceContainsBareVariable(source, expression))) extras.push(expression);
  }
  return { missing: remaining, extras };
}

function blockMathExpressions(markdown: string) {
  return [...markdown.matchAll(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g)].map((match) => canonicalMathExpression(match[0]));
}

/** Validate a cached fragment before reuse so old pipeline bugs cannot survive a new run. */
export function validateTranslatedFragment(source: string, translated: string) {
  const issues: string[] = [];
  if (/\[\[ATLAS_[A-Z]+_\d{6}\]\]/.test(translated)) issues.push("存在未恢复的结构化占位符");
  const mathComparison = mathContentEquivalent(source, translated);
  if (mathComparison.missing.length || mathComparison.extras.length) issues.push("公式内容或数量不一致");
  if (JSON.stringify(blockMathExpressions(source)) !== JSON.stringify(blockMathExpressions(translated))) issues.push("块级公式内容或顺序不一致");
  if (JSON.stringify(markdownImages(source)) !== JSON.stringify(markdownImages(translated))) issues.push("图片引用不一致");
  const sourceTables = tableRepresentations(source);
  const translatedTables = tableRepresentations(translated);
  if (sourceTables.length !== translatedTables.length) issues.push("表格数量不一致");
  if (sourceTables.length === translatedTables.length && sourceTables.some((table, index) => table.kind !== translatedTables[index].kind || (table.kind === "html" && htmlTableSignature(table.text) !== htmlTableSignature(translatedTables[index].text)))) issues.push("表格结构不一致");
  return issues;
}

function tableBlocks(markdown: string) {
  const tables: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length >= 2 && /^\s*\|?\s*:?-{3,}/.test(current[1])) tables.push(current);
    current = [];
  };
  for (const line of markdown.replace(/\r/g, "").split("\n")) {
    if (/^\s*\|.*\|\s*$/.test(line)) current.push(line.trim());
    else flush();
  }
  flush();
  return tables;
}

type TableRepresentation = { start: number; end: number; text: string; kind: "html" | "markdown" };

function tableRepresentations(markdown: string) {
  const tables: TableRepresentation[] = [];
  for (const match of markdown.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    tables.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: match[0], kind: "html" });
  }
  for (const match of markdown.matchAll(/^(?:\s*\|.*\|\s*(?:\n|$)){2,}/gm)) {
    tables.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: match[0].trimEnd(), kind: "markdown" });
  }
  return tables.sort((left, right) => left.start - right.start);
}

function htmlTableSignature(table: string) {
  const count = (pattern: RegExp) => (table.match(pattern) || []).length;
  return [count(/<tr\b/gi), count(/<td\b/gi), count(/<th\b/gi), count(/\browspan=/gi), count(/\bcolspan=/gi)].join(":");
}

/** Keep translated HTML tables when their structure is intact; restore the source table when a model rewrites a complex table. */
export function restoreTableLayout(source: string, translated: string) {
  const sourceTables = tableRepresentations(source);
  const translatedTables = tableRepresentations(translated);
  if (!sourceTables.length || sourceTables.length !== translatedTables.length) return translated;
  let result = translated;
  for (let index = translatedTables.length - 1; index >= 0; index -= 1) {
    const sourceTable = sourceTables[index];
    const translatedTable = translatedTables[index];
    const keepTranslated = sourceTable.kind === "html"
      && translatedTable.kind === "html"
      && htmlTableSignature(sourceTable.text) === htmlTableSignature(translatedTable.text);
    if (!keepTranslated) result = `${result.slice(0, translatedTable.start)}${sourceTable.text}${result.slice(translatedTable.end)}`;
  }
  return result;
}

function tableColumnCount(row: string) {
  const cells = row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/);
  return cells.length;
}

export function validateTranslatedMarkdown(source: string, translated: string, expectedTitle?: string) {
  const issues: string[] = [];
  issues.push(...validateStructuredBindings(source, translated));
  const sourceQuality = inspectSourceQuality(source);
  const translatedQuality = inspectSourceQuality(translated);
  const sourceImages = markdownImages(source);
  const translatedImages = markdownImages(translated);
  const sourceHeadings = markdownHeadings(source);
  const translatedHeadings = markdownHeadings(translated);
  const bodyHeadings = expectedTitle && translatedHeadings[0]?.depth === 1 ? translatedHeadings.slice(1) : translatedHeadings;
  const sourceTables = tableBlocks(source);
  const translatedTables = tableBlocks(translated);
  const sourceMath = mathExpressions(source);
  const translatedMath = mathExpressions(translated);
  const sourceBlockMath = blockMathExpressions(source);
  const translatedBlockMath = blockMathExpressions(translated);
  const sourceHtmlTables = tableRepresentations(source).filter((table) => table.kind === "html");
  const translatedHtmlTables = tableRepresentations(translated).filter((table) => table.kind === "html");
  const translatedWithoutBindingMarkers = translated.replace(/<!--ATLAS_BIND_(?:END_)?(?:figure|table|table_image)-\d{3}-->/gi, "");
  if (translatedWithoutBindingMarkers.includes("ATLAS_")) issues.push("存在未恢复的结构化占位符");
  if (sourceQuality.issues.length) issues.push(...sourceQuality.issues.map((issue) => `源文档质量问题：${issue.message}`));
  if (translatedQuality.issues.length) issues.push(...translatedQuality.issues.map((issue) => `译文质量问题：${issue.message}`));
  if (/^(?:\*\*)?(?:Figure|Fig\.?|Table)\s*\d+\s*[:：-]/im.test(translated)) issues.push("题注仍使用英文 Figure/Table 标签");
  if (/(?:^|\n)\s*>\s*(?:图|表|Figure|Table)\s*\d+\s*[:：-]/im.test(translated)) issues.push("题注包含异常 HTML 分隔符");
  if (expectedTitle && !translated.startsWith(`# ${expectedTitle}\n`)) issues.push("论文标题缺失或被改写");
  if ((translated.match(/^#\s+/gm) || []).length !== 1) issues.push("译文必须且只能包含一个一级标题");
  if (sourceHeadings.length !== bodyHeadings.length) issues.push(`章节数量不一致：原文 ${sourceHeadings.length}，译文 ${bodyHeadings.length}`);
  if (sourceHeadings.length === bodyHeadings.length && sourceHeadings.some((heading, index) => heading.depth !== bodyHeadings[index]?.depth)) issues.push("章节层级与原文不一致");
  if (JSON.stringify(sourceImages) !== JSON.stringify(translatedImages)) issues.push(`图片引用不一致：原文 ${sourceImages.length}，译文 ${translatedImages.length}`);
  const mathComparison = mathContentEquivalent(source, translated);
  if (mathComparison.missing.length || mathComparison.extras.length) issues.push(`公式内容或数量不一致：原文 ${sourceMath.length}，译文 ${translatedMath.length}`);
  if (JSON.stringify(sourceBlockMath) !== JSON.stringify(translatedBlockMath)) issues.push(`块级公式内容或顺序不一致：原文 ${sourceBlockMath.length}，译文 ${translatedBlockMath.length}`);
  const mathBlocks = translated.match(/\$\$[\s\S]*?\$\$/g) || [];
  if (mathBlocks.some((block) => /<[^>]*img\b/i.test(block))) issues.push("图片被错误包裹在公式块中");
  if (mathBlocks.some((block) => /<table\b/i.test(block))) issues.push("表格被错误包裹在公式块中");
  if ((translated.match(/```/g) || []).length % 2 !== 0) issues.push("代码围栏不成对");
  if ((translated.match(/^\s*\$\$\s*$/gm) || []).length % 2 !== 0) issues.push("块级公式围栏不成对");
  if (/上接前文|下接后文|翻译如下|以下是翻译/.test(translated)) issues.push("检测到模型添加的分块衔接语");
  if (/\[公式需回看原文 PDF\]|<!--\s*formula-not-decoded\s*-->/i.test(translated)) issues.push("存在未恢复公式");
  if (sourceTables.length !== translatedTables.length) issues.push(`表格数量不一致：原文 ${sourceTables.length}，译文 ${translatedTables.length}`);
  translatedTables.forEach((table, tableIndex) => {
    const columns = tableColumnCount(table[0]);
    if (table.some((row) => tableColumnCount(row) !== columns)) issues.push(`表格 ${tableIndex + 1} 的列数不一致`);
    if (sourceTables[tableIndex] && sourceTables[tableIndex].length !== table.length) issues.push(`表格 ${tableIndex + 1} 的行数不一致`);
  });
  if (sourceHtmlTables.length !== translatedHtmlTables.length) issues.push(`HTML 表格数量不一致：原文 ${sourceHtmlTables.length}，译文 ${translatedHtmlTables.length}`);
  if (sourceHtmlTables.length === translatedHtmlTables.length && sourceHtmlTables.some((table, index) => htmlTableSignature(table.text) !== htmlTableSignature(translatedHtmlTables[index].text))) {
    issues.push("HTML 表格的行列或合并单元格结构不一致");
  }
  translatedHtmlTables.forEach((table, index) => {
    if (/<th\b/i.test(table.text) && /<\/thead>\s*<tr\b[^>]*>(?:\s*<td\b[^>]*>\s*(?:\d+s|Avg\.?|Target|Path)\b){2}/i.test(table.text)) {
      issues.push(`HTML 表格 ${index + 1} 仍存在未归入表头的首行`);
    }
  });
  const textOutsideMath = translated.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, "");
  if (/\\(?:frac|begin|end|text|mathbb|mathbf|mathcal|tag)\b/.test(textOutsideMath)) issues.push("检测到可能未包裹的 LaTeX 公式");
  return [...new Set(issues)];
}

function equationLike(line: string) {
  if (/<\/?(?:table|thead|tbody|tfoot|tr|td|th|div|img)\b/i.test(line)) return false;
  // Bibliography entries and URLs can contain "=" (e.g. ?journalCode=jgcd) but
  // must never be promoted to display math.
  if (/https?:|doi\.org|arXiv|\[(?:Online|在线)\]|et al\.|vol\.\s*\d|pp\.\s*\d/i.test(line)) return false;
  const hasMathCommand = /\\(?:frac|begin|end|text|mathbb|mathbf|mathcal|left|right|tag|operatorname|exp|sum|int|sqrt|cdot|top|hat|tilde|Delta|lambda|in|sim|partial|nabla|geq|leq)/.test(line);
  const hasAssignment = /=/.test(line);
  const hasChineseSentence = /[\u4e00-\u9fff]{8,}/.test(line);
  return !hasChineseSentence && (hasMathCommand || hasAssignment);
}

function cleanMathBody(line: string) {
  return normalizeMathBody(line.replace(/\\\(|\\\)|\\\[|\\\]/g, "").trim());
}

function removeDuplicateMathFences(markdown: string) {
  const output: string[] = [];
  let inCodeFence = false;
  let lastNonEmpty = -1;
  for (const rawLine of markdown.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) inCodeFence = !inCodeFence;
    if (!inCodeFence && line === "$$" && lastNonEmpty >= 0 && output[lastNonEmpty]?.trim() === "$$") continue;
    output.push(rawLine);
    if (line) lastNonEmpty = output.length - 1;
  }
  return output.join("\n");
}

function repairMalformedMathFences(markdown: string) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const output: string[] = [];
  let inMath = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "$$") {
      output.push(lines[index]);
      continue;
    }
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next < lines.length && lines[next].trim() === "$$") {
      const previous = [...output].reverse().find((line) => line.trim()) || "";
      const following = lines.slice(next + 1).find((line) => line.trim()) || "";
      if (!inMath && equationLike(following)) {
        output.push("$$");
        inMath = true;
      } else if (inMath && /\\begin\{cases\}|\\\\\s*$/.test(previous)) {
        // DeepSeek sometimes inserts an empty fence inside a cases block.
      } else if (!inMath) {
        // Drop an empty display-math block.
      } else {
        output.push(lines[index]);
        inMath = false;
        output.push(...lines.slice(index + 1, next + 1));
        inMath = true;
      }
      index = next;
      continue;
    }
    output.push(lines[index]);
    inMath = !inMath;
  }
  return output.join("\n");
}

function canonicalizeLegacyMath(markdown: string) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const output: string[] = [];
  const pending: string[] = [];
  let inCodeFence = false;
  const flush = () => {
    if (!pending.length) return;
    output.push("$$", ...pending, "$$");
    pending.length = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      flush();
      inCodeFence = !inCodeFence;
      output.push(rawLine);
      continue;
    }
    if (!inCodeFence && line === "$$") continue;
    if (!inCodeFence && !line) {
      const following = lines.slice(index + 1).find((item) => item.trim()) || "";
      if (pending.length && equationLike(following)) continue;
      flush();
      output.push(rawLine);
      continue;
    }
    if (!inCodeFence && equationLike(line) && !line.includes("$") && !line.startsWith("#")) {
      if (pending.length && /\\tag\s*\{/.test(pending[pending.length - 1]) && /\\tag\s*\{/.test(line)) flush();
      pending.push(cleanMathBody(line));
      continue;
    }
    flush();
    output.push(rawLine);
  }
  flush();
  return output.join("\n");
}

function wrapUnfencedEquationLines(markdown: string) {
  const output: string[] = [];
  let inCodeFence = false;
  let inMath = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      output.push(rawLine);
      continue;
    }
    if (inCodeFence) {
      output.push(rawLine);
      continue;
    }
    if (line === "$$") {
      inMath = !inMath;
      output.push(rawLine);
      continue;
    }
    if (!inMath && equationLike(line) && !line.includes("$") && !line.startsWith("#")) {
      output.push("$$", cleanMathBody(line), "$$");
      continue;
    }
    output.push(rawLine);
  }
  return output.join("\n");
}

function normalizeLatexDelimiters(markdown: string) {
  return markdown
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `\n$$\n${body}\n$$\n`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_match, body: string) => `$${body}$`)
    .replace(/([^\n])\s+(#{2,4}\s+)/g, "$1\n\n$2");
}

function expandSingleLineMath(markdown: string) {
  const output: string[] = [];
  let inCodeFence = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      output.push(rawLine);
      continue;
    }
    if (!inCodeFence && line.startsWith("$$") && line.endsWith("$$") && line.length > 4) {
      output.push("$$", line.slice(2, -2).trim(), "$$");
      continue;
    }
    output.push(rawLine);
  }
  return output.join("\n");
}

export function normalizeTranslatedMarkdown(markdown: string) {
  const output: string[] = [];
  let inFence = false;
  let inMathBlock = false;
  const rawMathFenceCount = (markdown.match(/\$\$\s*\n\s*\$\$/g) || []).length;
  const repaired = repairMalformedMathFences(removeDuplicateMathFences(markdown));
  const legacySafe = rawMathFenceCount > 3 ? canonicalizeLegacyMath(repaired) : repaired;
  const normalizedInput = expandSingleLineMath(normalizeInlineVariables(removeParserPageSeparators(normalizeMathExpressions(normalizeLatexDelimiters(legacySafe).replace(/<!--\s*formula-not-decoded\s*-->/gi, "[公式需回看原文 PDF]")))));
  for (const rawLine of normalizedInput.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      output.push(rawLine);
      continue;
    }
    if (inFence) {
      output.push(rawLine);
      continue;
    }
    if (line === "$$") {
      inMathBlock = !inMathBlock;
      output.push(rawLine);
      continue;
    }
    if (inMathBlock || !line) {
      output.push(rawLine);
      continue;
    }
    if (/^\\\[.*\\\]$/.test(line)) {
      output.push("$$", line.slice(2, -2).trim(), "$$");
      continue;
    }
    if (/^\\\(.*\\\)$/.test(line)) {
      output.push(`$${line.slice(2, -2).trim()}$`);
      continue;
    }
    const closingMath = line.indexOf("$$");
    if (closingMath > 0 && equationLike(line.slice(0, closingMath))) {
      output.push("$$", cleanMathBody(line.slice(0, closingMath)), "$$");
      if (line.slice(closingMath + 2).trim()) output.push(line.slice(closingMath + 2).trim());
      continue;
    }
    if (equationLike(line) && !line.includes("$") && !line.startsWith("#")) {
      output.push("$$", cleanMathBody(line), "$$");
      continue;
    }
    if (/^#\s+/.test(line)) {
      const heading = line.replace(/^#\s+/, "");
      output.push(`## ${heading}`);
      continue;
    }
    output.push(rawLine);
  }
  if (inMathBlock) output.push("$$");
  return normalizeInlineVariables(normalizeMathExpressions(wrapUnfencedEquationLines(output.join("\n")))).replace(/^\s*---\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Apply parser-owned labels after model translation. */
export function normalizeTranslatedStructureLabels(markdown: string, captionsOnlyInBindings = false) {
  let inBinding = false;
  return markdown.split("\n").map((rawLine) => {
    const startsBinding = /<!--\s*ATLAS_BIND_[^>]+-->/i.test(rawLine);
    const endsBinding = /<!--\s*ATLAS_BIND_END_[^>]+-->/i.test(rawLine);
    const captionScope = !captionsOnlyInBindings || inBinding || startsBinding;
    const heading = rawLine.match(/^(\s*)(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const normalizedHeading = heading[3]
        .replace(/^References?$/i, "参考文献")
        .replace(/^Bibliography$/i, "参考文献")
        .replace(/^Benchmark$/i, "基准");
      return `${heading[1]}${heading[2]} ${normalizedHeading}`;
    }

    const caption = rawLine.match(new RegExp(`^(\\s*)(<!--\\s*ATLAS_BIND_[^>]+-->)?\\s*(?:\\*\\*)?(Figure|Fig\\.?|Table|图|表)\\s*(${CAPTION_NUMBER_PATTERN})\\s*[:：-]\\s*(?:\\*\\*)?\\s*(.*)$`, "i"));
    if (!caption || !captionScope) {
      if (startsBinding) inBinding = true;
      if (endsBinding) inBinding = false;
      if (!captionScope) {
        const unboundBoldCaption = rawLine.match(new RegExp(`^(\\s*)\\*\\*(图|表)\\s*(${CAPTION_NUMBER_PATTERN})\\s*：\\*\\*\\s*(.*)$`));
        if (unboundBoldCaption) return `${unboundBoldCaption[1]}${unboundBoldCaption[2]} ${captionNumberValue(unboundBoldCaption[3])} ${unboundBoldCaption[4]}`.replace(/\s+$/, "");
      }
      return rawLine;
    }
    const label = /^(?:Figure|Fig\.?|图)$/i.test(caption[3]) ? "图" : "表";
    const normalized = `${caption[1]}${caption[2] || ""}**${label} ${captionNumberValue(caption[4])}：** ${caption[5]}`.replace(/\s+$/, "");
    if (startsBinding) inBinding = true;
    if (endsBinding) inBinding = false;
    return normalized;
  }).join("\n");
}

export function translationPrompt(chunk: string, index: number | string, total: number, glossary = "") {
  return `你是严谨的中文科研论文排版翻译助手。请把下面论文原文第 ${index}/${total} 个片段翻译成简体中文，并直接输出可阅读的 Markdown。

这是已经按论文阅读顺序整理好的结构化 Markdown。必须保留现有结构，绝不编造原文中没有的内容：

1. 只翻译自然语言，不删减、不总结、不补写；保持原文段落顺序。
2. 标题的 Markdown 层级必须原样保留，不得新增、删除、合并、重排或改变层级；不要输出论文主标题。
3. 公式必须保留。行内公式使用 $...$，独立公式使用 $$...$$；保留 LaTeX 命令、上下标、希腊字母和变量，不要把公式改写成自然语言。正文中出现的单字母变量、带下标变量和“变量 = 数值”也必须使用行内公式。若 PDF 文本中的公式已经损坏或缺失，写 [公式需回看原文 PDF]，不要猜。
4. GFM Markdown 表格的列数、行数、分隔行和单元格顺序必须保持不变；HTML 表格必须原样保留；表格结构占位符（例如 [[ATLAS_TABLE_000001]]）必须逐字符原样保留。
5. 保留 Figure/Table 的类型、编号、图注、表注、引用键、数字、单位、数据集名、模型名、指标名和代码。绝不能把 Figure 改成 Table，或把 Table 改成 Figure。图注翻译成中文，但不要伪造图片内容；使用 **图 1：**、**表 1：** 这样的明确标记。
6. 图片 Markdown、图片路径、图表题标签占位符、资源占位符（例如 [[ATLAS_ASSET_000001]]、[[ATLAS_CAPTION_000001]]）必须原样保留，不得删除、移动到别处、改名或包进公式。
7. 图表绑定围栏（例如 [[ATLAS_BIND_000001]]、[[ATLAS_BIND_000002]]）必须逐字符原样保留；围栏内的图片/表格与题注是一体，绝不能跨围栏移动、交换或拆开。
8. 公式占位符（例如 [[ATLAS_MATH_000001]]）必须逐字符原样保留；不要把它翻译成文字，也不要在它周围添加代码围栏或数字。
9. 代码块原样保留并用 Markdown 代码围栏；不要用代码围栏包住整段译文。
10. 严格遵守下方术语表；作者名、模型名、数据集名、指标名和引用键不要翻译。
11. 不要输出“翻译如下”、“上接前文”、“下接后文”、总结、解释、分隔线或本片段之外的内容。
12. 严禁新增、复制、猜测或重新编号任何 [[ATLAS_...]] 占位符：输出中只能出现输入片段里逐字符存在过的占位符，且每个只能出现一次；对应图片/表格/公式缺失时保留原占位符，不要编造新占位符或新内容。
13. 不要把参考文献、URL、引用条目、页码或普通句子包进 $...$ / $$...$$：公式围栏内只能放数学公式。

术语表：
${glossary || "以论文原文为准；作者名、模型名、数据集名和指标名保持不变。"}

原文片段（第 ${index}/${total}）：
${chunk}`;
}

/** Detect protected placeholders in model output that were not part of the input chunk. */
export function findUnknownProtectedTokens(content: string, knownTokens: string[] = []) {
  const known = new Set(knownTokens);
  return [...new Set([...content.matchAll(/\[\[ATLAS_[A-Z]+_\d{6}\]\]/g)].map((match) => match[0]))].filter((token) => !known.has(token));
}

/**
 * Models occasionally wrap a bibliography entry or URL in display math
 * ($$...$$). That is never a legitimate formula; unwrap it deterministically
 * so the document can be validated and published.
 */
export function unwrapReferenceMathBlocks(markdown: string) {
  return markdown.replace(/\$\$([\s\S]*?)\$\$/g, (block, body: string) =>
    /https?:|doi\.org|arXiv|vol\.\s*\d|pp\.\s*\d|et al\.|\[\d+\]\s+[A-Z"“]|Journal|Proceedings|Conference|Magazine/i.test(body)
      ? body.trim()
      : block,
  );
}
