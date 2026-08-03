import { createHash } from "node:crypto";

export const TRANSLATION_FORMAT_VERSION = "structured-pdf-v7";

export function translationSourceHash(paper: { title: string; abstract?: string | null; pdf_url?: string | null; doi?: string | null }) {
  return createHash("sha256").update([TRANSLATION_FORMAT_VERSION, paper.title, paper.abstract || "", paper.pdf_url || "", paper.doi || ""].join("\n")).digest("hex");
}

export function translationDirectory(paperId: number) {
  return `data/translations/${paperId}`;
}

function looksLikePdfUrl(value: string) {
  return /arxiv\.org\/pdf|\.pdf(?:[?#]|$)|download/i.test(value);
}

export function translationUrlCandidates(paper: { pdf_url?: string | null; arxiv_id?: string | null }, alternatives: Array<{ pdf_url?: string | null; arxiv_id?: string | null }> = []) {
  const urls = [paper.pdf_url || "", ...alternatives.flatMap((item) => [item.pdf_url || ""]), paper.arxiv_id ? `https://arxiv.org/pdf/${paper.arxiv_id.replace(/\.pdf$/, "")}.pdf` : "", ...alternatives.map((item) => item.arxiv_id ? `https://arxiv.org/pdf/${item.arxiv_id.replace(/\.pdf$/, "")}.pdf` : "")].filter(Boolean);
  return [...new Set(urls)].sort((left, right) => Number(looksLikePdfUrl(right)) - Number(looksLikePdfUrl(left)));
}

export function splitTranslationChunks(text: string, maxChars = 9000) {
  const paragraphs = text.replace(/\r/g, "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) { chunks.push(current); current = ""; }
      for (let index = 0; index < paragraph.length; index += maxChars) chunks.push(paragraph.slice(index, index + maxChars));
      continue;
    }
    if (current && current.length + paragraph.length + 2 > maxChars) { chunks.push(current); current = ""; }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
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
    const token = `ATLAS_${kind}_${protectedTokens.length}`;
    protectedTokens.push({ token, value });
    return token;
  };

  let text = markdown.replace(/!\[[^\]]*\]\([^\)]+\)/g, (value) => protect(value, "ASSET"));
  text = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]+\$|\\\([^\n]+\\\)/g, (value) => protect(value, "MATH"));
  return { text, protectedTokens };
}

export function restoreStructuredMarkdown(markdown: string, protectedTokens: ProtectedToken[]) {
  return protectedTokens.reduce((result, item) => result.replaceAll(item.token, () => item.value), markdown);
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

export function validateTranslatedMarkdown(source: string, translated: string) {
  const issues: string[] = [];
  const sourceImages = (source.match(/!\[/g) || []).length;
  const translatedImages = (translated.match(/!\[/g) || []).length;
  if (translated.includes("ATLAS_")) issues.push("存在未恢复的结构化占位符");
  if (translatedImages < sourceImages) issues.push(`图片数量减少：原文 ${sourceImages}，译文 ${translatedImages}`);
  if ((translated.match(/^#\s+/gm) || []).length > 1) issues.push("译文包含多个一级标题");
  const textOutsideMath = translated.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, "");
  if (/\\(?:frac|begin|end|text|mathbb|mathbf|mathcal|tag)\b/.test(textOutsideMath)) issues.push("检测到可能未包裹的 LaTeX 公式");
  return issues;
}

function equationLike(line: string) {
  const hasMathCommand = /\\(?:frac|begin|end|text|mathbb|mathbf|mathcal|left|right|tag|operatorname|exp|sum|int|sqrt|cdot|top|hat|tilde|Delta|lambda|in|sim|partial|nabla|geq|leq)/.test(line);
  const hasAssignment = /=/.test(line);
  const hasChineseSentence = /[\u4e00-\u9fff]{8,}/.test(line);
  return !hasChineseSentence && (hasMathCommand || hasAssignment);
}

function cleanMathBody(line: string) {
  return line.replace(/\\\(|\\\)|\\\[|\\\]/g, "").trim();
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
  const normalizedInput = expandSingleLineMath(normalizeLatexDelimiters(legacySafe).replace(/<!--\s*formula-not-decoded\s*-->/gi, "[公式需回看原文 PDF]"));
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
      if (heading.length >= 18 && !/^(?:[IVX]+\.?|\d+(?:\.\d+)?)\s/.test(heading)) continue;
      output.push(`## ${heading}`);
      continue;
    }
    output.push(rawLine);
  }
  if (inMathBlock) output.push("$$");
  return wrapUnfencedEquationLines(output.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
}

export function translationPrompt(chunk: string, index: number, total: number) {
  return `你是严谨的中文科研论文排版翻译助手。请把下面论文原文第 ${index}/${total} 个片段翻译成简体中文，并直接输出可阅读的 Markdown。

这是从 PDF 提取的文本，必须把信息结构恢复成 Markdown，但绝不编造 PDF 中没有的内容：

1. 只翻译自然语言，不删减、不总结、不补写；保持原文段落顺序。
2. 识别明确的章节标题：论文主标题用一次“#”，一级章节用“##”，子章节用“###”。不要把普通句子、图注、表头或加粗短语误当标题；本片段不是论文开头时不要重复主标题。
3. 公式必须保留。行内公式使用 $...$，独立公式使用 $$...$$；保留 LaTeX 命令、上下标、希腊字母和变量，不要把公式改写成自然语言。若 PDF 文本中的公式已经损坏或缺失，写 [公式需回看原文 PDF]，不要猜。
4. 表格尽量输出 GFM Markdown 表格；不能可靠恢复时保留原始表格文本，并标记 [表格需回看原文 PDF]。
5. 保留 Figure/Table 编号、图注、表注、引用键、数字、单位、数据集名、模型名、指标名和代码。图注翻译成中文，但不要伪造图片内容；使用 **图 1：**、**表 1：** 这样的明确标记。
6. 图片 Markdown、图片路径、资源占位符（例如 ATLAS_ASSET_0）必须原样保留，不得删除、移动到别处或改名。
7. 公式占位符（例如 ATLAS_MATH_1）必须原样保留；不要把它翻译成文字，也不要在它周围添加代码围栏。
8. 代码块原样保留并用 Markdown 代码围栏；不要用代码围栏包住整段译文。
9. BEV、E2E、VLA、MPC、nuScenes、CARLA 等术语保持一致；模型名、数据集名和引用键不要翻译。
10. 不要输出“翻译如下”、总结、解释或本片段之外的内容。

原文片段（第 ${index}/${total}）：
${chunk}`;
}
