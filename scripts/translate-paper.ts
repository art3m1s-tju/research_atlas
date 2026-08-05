import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ensureResearchFeatureSchema } from "../src/lib/research-features";
import { annotateStructuredBindings, applySemanticBindingDecisions, assessTextExtractionCompleteness, buildDocumentIR, buildStructuredBindingManifest, compareAuthorSources, extractPaperAffiliations, extractPaperAuthorAffiliations, findUnknownProtectedTokens, inspectSourceQuality, normalizeBoundCaptionPlacement, normalizeExtraNumberedHeadings, normalizeTranslatedMarkdown, normalizeTranslatedStructureLabels, numberReferenceSection, pdfLinksFromLandingHtml, prepareTranslationSource, protectStructuredMarkdown, repairSourceQuality, restoreBindingOrder, restoreHeadingLayout, restoreStructuredMarkdown, splitTranslationChunks, stripStructuredBindingMarkers, translationDirectory, translationPrompt, translationSourceHash, translationUrlCandidates, unwrapReferenceMathBlocks, validateTranslatedFragment, validateTranslatedMarkdown } from "../src/lib/paper-translation";
import { fetchWithRetry } from "../src/lib/resilient-fetch";
import { assertTranslationOwnership, claimTranslationJob, failTranslationJob, finishTranslationJob, refreshTranslationLease, startTranslationJob, updateTranslationJobMetadata, updateTranslationProgress } from "../src/lib/translation-job";

const PADDLEOCR_DEFAULT_BASE_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const PADDLEOCR_DEFAULT_MODEL = "PaddleOCR-VL-1.6";
const execFileAsync = promisify(execFile);
let dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");
let model = process.env.DEEPSEEK_TRANSLATION_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
let apiBaseUrl = process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com";
let concurrency = Math.max(1, Math.min(4, Number(process.env.TRANSLATION_CONCURRENCY || 2)));
let activeJobToken = "";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

type ParserProgress = (phase: string, message: string, current?: number, total?: number) => void;

function networkErrorDetail(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause as { message?: string; code?: string; errno?: string | number; syscall?: string; hostname?: string } | undefined;
  const details = [error.message];
  if (cause?.message && cause.message !== error.message) details.push(cause.message);
  if (cause?.code) details.push(`code=${cause.code}`);
  if (cause?.errno !== undefined) details.push(`errno=${cause.errno}`);
  if (cause?.syscall) details.push(`syscall=${cause.syscall}`);
  if (cause?.hostname) details.push(`host=${cause.hostname}`);
  return [...new Set(details)].join("；");
}

async function paddleOcrFetch(url: string, init: RequestInit, action: string, attempts = 3, idempotencyKey?: string) {
  return fetchWithRetry(url, init, {
    attempts,
    timeoutMs: 60000,
    retryPost: String(init.method || "GET").toUpperCase() === "POST",
    retryStatusOnPost: false,
    idempotencyKey,
    onRetry: ({ attempt, error, status, delayMs }) => {
      console.warn(`  PaddleOCR ${action}第 ${attempt} 次尝试失败（${error ? networkErrorDetail(error) : `HTTP ${status}`}），${delayMs}ms 后重试`);
    },
  });
}

function safeAssetName(value: string, pageIndex: number, assetIndex: number) {
  const name = path.basename(value.split("?")[0]).replace(/[^a-zA-Z0-9._-]/g, "-") || `image-${assetIndex + 1}.png`;
  return `page-${pageIndex + 1}-${assetIndex + 1}-${name}`;
}

async function paddleOcrResponse(response: Response, action: string) {
  const text = await response.text();
  if (!response.ok) throw new Error(`PaddleOCR ${action}失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
  const payload = JSON.parse(text);
  if (payload.code !== 0) throw new Error(`PaddleOCR ${action}失败（${payload.code}）：${payload.msg || "未知错误"}`);
  return payload.data;
}

type VisualDecision = {
  id: string;
  semantic_kind: "figure" | "table_image";
  confidence: number;
  reason: string;
};

/**
 * PaddleOCR-VL accepts image files even though the DeepSeek text endpoint does
 * not accept image_url content. Use it only for cropped visual assets, so the
 * semantic pass stays cheap and never falls back to local PDF parsing.
 */
async function reviewVisualAssetWithPaddleOcr(id: string, assetPath: string, outputDirectory: string): Promise<VisualDecision> {
  const token = process.env.PADDLEOCR_ACCESS_TOKEN;
  if (!token) throw new Error("PADDLEOCR_ACCESS_TOKEN 未配置");
  const apiUrl = process.env.PADDLEOCR_API_BASE_URL || PADDLEOCR_DEFAULT_BASE_URL;
  const parserModel = process.env.PADDLEOCR_MODEL || PADDLEOCR_DEFAULT_MODEL;
  const bytes = await fs.readFile(path.join(outputDirectory, assetPath));
  const mime = /\.png$/i.test(assetPath) ? "image/png" : /\.webp$/i.test(assetPath) ? "image/webp" : "image/jpeg";
  const clientJobId = randomUUID();
  const form = new FormData();
  form.append("model", parserModel);
  form.append("optionalPayload", JSON.stringify({ useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: true, prettifyMarkdown: true, client_job_id: clientJobId }));
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), path.basename(assetPath));
  const submitted = await paddleOcrFetch(apiUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Idempotency-Key": clientJobId }, body: form, signal: AbortSignal.timeout(60000) }, "视觉对象提交", 2, clientJobId);
  const job = await paddleOcrResponse(submitted, "视觉对象提交");
  if (!job?.jobId) throw new Error("PaddleOCR 视觉对象任务没有返回 jobId");
  const deadline = Date.now() + Math.max(60000, Number(process.env.PADDLEOCR_VISUAL_TIMEOUT_MS || 120000));
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const response = await paddleOcrFetch(`${apiUrl}/${encodeURIComponent(job.jobId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) }, "视觉对象状态查询");
    const result = await paddleOcrResponse(response, "视觉对象状态查询");
    if (result.state === "failed") throw new Error(`PaddleOCR 视觉对象解析失败：${result.errorMsg || "未知错误"}`);
    if (result.state !== "done") continue;
    const jsonUrl = result.resultUrl?.jsonUrl;
    if (!jsonUrl) throw new Error("PaddleOCR 视觉对象完成但没有 JSON 结果地址");
    const jsonResponse = await paddleOcrFetch(jsonUrl, { signal: AbortSignal.timeout(60000) }, "视觉对象结果下载");
    const payload = JSON.parse(await jsonResponse.text());
    const pages = payload.result?.layoutParsingResults || [];
    const blocks = pages.flatMap((page: any) => page.prunedResult?.parsing_res_list || page.parsing_res_list || []);
    const tableBlock = blocks.find((block: any) => String(block.block_label || block.label || "").toLowerCase() === "table");
    if (tableBlock) {
      const scores = pages.flatMap((page: any) => page.prunedResult?.layout_det_res?.boxes || []).filter((box: any) => String(box.label || "").toLowerCase() === "table").map((box: any) => Number(box.score)).filter(Number.isFinite);
      return { id, semantic_kind: "table_image", confidence: Math.max(0.8, Math.min(0.99, scores[0] || 0.9)), reason: "PaddleOCR-VL 检测到表格版面" };
    }
    return { id, semantic_kind: "figure", confidence: 0.9, reason: "PaddleOCR-VL 未检测到表格版面" };
  }
  throw new Error(`PaddleOCR 视觉对象解析超时（${id}）`);
}

/** Qwen3-VL is the preferred visual reviewer when a DashScope key is present. */
async function reviewVisualAssetWithQwen(id: string, assetPath: string, outputDirectory: string, caption = ""): Promise<VisualDecision> {
  const apiKey = process.env.QWEN_VL_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("QWEN_VL_API_KEY/DASHSCOPE_API_KEY 未配置");
  const baseUrl = (process.env.QWEN_VL_API_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const modelName = process.env.QWEN_VL_MODEL || "qwen3-vl-flash";
  const bytes = await fs.readFile(path.join(outputDirectory, assetPath));
  const mime = /\.png$/i.test(assetPath) ? "image/png" : /\.webp$/i.test(assetPath) ? "image/webp" : "image/jpeg";
  const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      temperature: 0,
      max_tokens: 180,
      stream: false,
      messages: [
        { role: "system", content: "你是论文版面审校器，必须先检查图像本身。只有当图像清晰包含行列网格、单元格、表头和多行数据时才返回 table_image；轨迹图、热力图、流程图、照片拼图、坐标图都返回 figure。只输出 JSON。" },
        { role: "user", content: [
          { type: "text", text: `对象 ${id}：必须根据像素内容判断，不要根据文件名或题注猜测。如果图中是带表头和多行数据的行列单元格表格截图，semantic_kind 返回 table_image；否则（包括系统架构图、轨迹图、热力图、照片拼图）返回 figure。该对象的 OCR 题注候选是：${caption || "无"}。题注只用于配对参考，不能改变图像类型。格式：{"semantic_kind":"figure|table_image","confidence":0.0,"reason":"不超过30字"}` },
          { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } },
        ] },
      ],
    }),
  }, {
    attempts: 2,
    timeoutMs: 30000,
    retryPost: true,
    retryStatusOnPost: true,
    idempotencyKey: randomUUID(),
    onRetry: ({ attempt, error, status, delayMs }) => {
      console.warn(`  Qwen3-VL 视觉审校第 ${attempt} 次尝试失败（${error ? networkErrorDetail(error) : `HTTP ${status}`}），${delayMs}ms 后重试`);
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Qwen3-VL 视觉审校失败（HTTP ${response.status}）：${text.slice(0, 240)}`);
  const data = JSON.parse(text);
  const content = String(data.choices?.[0]?.message?.content || "");
  const candidate = content.match(/\{[\s\S]*\}/)?.[0];
  const parsed = candidate ? JSON.parse(candidate) : null;
  const kind = parsed?.semantic_kind === "table_image" ? "table_image" : parsed?.semantic_kind === "figure" ? "figure" : null;
  if (!kind) throw new Error(`Qwen3-VL 返回无法解析：${content.slice(0, 160)}`);
  return { id, semantic_kind: kind, confidence: Math.max(0.65, Math.min(0.99, Number(parsed.confidence) || 0.85)), reason: String(parsed.reason || "Qwen3-VL 视觉判断").slice(0, 40) };
}

async function reviewVisualAsset(id: string, assetPath: string, outputDirectory: string, caption = ""): Promise<VisualDecision> {
  if (process.env.QWEN_VL_API_KEY || process.env.DASHSCOPE_API_KEY) return reviewVisualAssetWithQwen(id, assetPath, outputDirectory, caption);
  return reviewVisualAssetWithPaddleOcr(id, assetPath, outputDirectory);
}

async function parsePaddleOcrJsonl(jsonl: string, outputDirectory: string) {
  const pages = jsonl.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const payload = JSON.parse(line);
    return payload.result?.layoutParsingResults || [];
  });
  if (!pages.length) throw new Error("PaddleOCR 返回结果中没有版面解析页面");

  const assetsDirectory = path.join(outputDirectory, "assets");
  await fs.rm(assetsDirectory, { recursive: true, force: true });
  await fs.mkdir(assetsDirectory, { recursive: true });
  const assets: string[] = [];
  const markdownPages: string[] = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    let markdown = String(page.markdown?.text || "").trim();
    const images = Object.entries(page.markdown?.images || {}) as Array<[string, string]>;
    for (let assetIndex = 0; assetIndex < images.length; assetIndex += 1) {
      const [sourcePath, imageUrl] = images[assetIndex];
      let replacement = imageUrl;
      try {
        const response = await paddleOcrFetch(imageUrl, { signal: AbortSignal.timeout(60000) }, "图片下载");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const relativePath = path.posix.join("assets", safeAssetName(sourcePath, pageIndex, assetIndex));
        await fs.writeFile(path.join(outputDirectory, relativePath), Buffer.from(await response.arrayBuffer()));
        assets.push(relativePath);
        replacement = relativePath;
      } catch (error) {
        console.warn(`  PaddleOCR 图片下载失败，保留远程地址：${networkErrorDetail(error)}`);
      }
      markdown = markdown.replaceAll(sourcePath, replacement);
    }
    if (markdown) markdownPages.push(markdown);
  }

  const markdown = markdownPages.join("\n\n---\n\n").trim();
  if (!markdown) throw new Error("PaddleOCR 没有生成结构化 Markdown");
  return { markdown, assets, pageCount: pages.length };
}

async function parseWithPaddleOcr(pdfPath: string, sourceUrl: string, outputDirectory: string, onProgress: ParserProgress) {
  const token = process.env.PADDLEOCR_ACCESS_TOKEN;
  if (!token) throw new Error("PADDLEOCR_ACCESS_TOKEN 未配置");
  const apiUrl = process.env.PADDLEOCR_API_BASE_URL || PADDLEOCR_DEFAULT_BASE_URL;
  const parserModel = process.env.PADDLEOCR_MODEL || PADDLEOCR_DEFAULT_MODEL;
  const clientJobId = randomUUID();
  const options = {
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useChartRecognition: true,
    prettifyMarkdown: true,
    client_job_id: clientJobId,
  };
  const form = new FormData();
  form.append("model", parserModel);
  form.append("optionalPayload", JSON.stringify(options));
  form.append("file", new Blob([new Uint8Array(await fs.readFile(pdfPath))], { type: "application/pdf" }), path.basename(pdfPath));
  onProgress("parsing", `正在上传 PDF 至 ${parserModel}`);
  const submitted = await paddleOcrFetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Idempotency-Key": clientJobId },
    body: form,
    signal: AbortSignal.timeout(60000),
  }, "任务提交", 2, clientJobId);
  const job = await paddleOcrResponse(submitted, "任务提交");
  if (!job?.jobId) throw new Error("PaddleOCR 没有返回 jobId");

  const timeoutMs = Math.max(60000, Number(process.env.PADDLEOCR_POLL_TIMEOUT_MS || 20 * 60 * 1000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const response = await paddleOcrFetch(`${apiUrl}/${encodeURIComponent(job.jobId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) }, "状态查询");
    const result = await paddleOcrResponse(response, "状态查询");
    const current = Number(result.extractProgress?.extractedPages || 0);
    const total = Number(result.extractProgress?.totalPages || 0);
    if (result.state === "pending" || result.state === "running") {
      onProgress("parsing", result.state === "running"
        ? (total ? `PaddleOCR-VL-1.6 正在解析 ${current}/${total} 页` : "PaddleOCR-VL-1.6 正在解析论文")
        : "PaddleOCR-VL-1.6 已提交，正在等待云端解析", current, total);
    }
    if (result.state === "failed") throw new Error(`PaddleOCR 解析失败：${result.errorMsg || "未知错误"}`);
    if (result.state !== "done") continue;

    onProgress("parsing", "PaddleOCR-VL-1.6 解析完成，正在整理 Markdown 和图片", current || total, total);
    const jsonUrl = result.resultUrl?.jsonUrl;
    if (!jsonUrl) throw new Error("PaddleOCR 完成任务但没有返回 JSON 结果地址");
    const jsonResponse = await paddleOcrFetch(jsonUrl, { signal: AbortSignal.timeout(60000) }, "结果下载");
    if (!jsonResponse.ok) throw new Error(`PaddleOCR 结果下载失败（HTTP ${jsonResponse.status}）`);
    const parsed = await parsePaddleOcrJsonl(await jsonResponse.text(), outputDirectory);
    const markdownPath = path.join(outputDirectory, "source_structured.md");
    await fs.writeFile(markdownPath, `${parsed.markdown}\n`, "utf8");
    const manifest = {
      parser: "paddleocr",
      parser_model: parserModel,
      source_pdf: sourceUrl,
      pdf_sha256: createHash("sha256").update(await fs.readFile(pdfPath)).digest("hex"),
      markdown: "source_structured.md",
      page_count: parsed.pageCount,
      assets: parsed.assets,
      job_id: job.jobId,
    };
    await fs.writeFile(path.join(outputDirectory, "document.json"), JSON.stringify(manifest, null, 2), "utf8");
    return { markdown: parsed.markdown, parser: "paddleocr", manifest };
  }
  throw new Error(`PaddleOCR 解析超时（${Math.round(timeoutMs / 60000)} 分钟）`);
}

async function writePdfHashManifest(pdfPath: string, outputDirectory: string, manifest: Record<string, unknown>) {
  const withHash = { ...manifest, pdf_sha256: createHash("sha256").update(await fs.readFile(pdfPath)).digest("hex") };
  await fs.writeFile(path.join(outputDirectory, "document.json"), JSON.stringify(withHash, null, 2), "utf8");
  return withHash;
}

async function runDoclingParser(pdfPath: string, outputDirectory: string, onProgress: ParserProgress) {
  const pythonBin = process.env.TRANSLATION_PYTHON_BIN || path.join(process.cwd(), ".venv-atlas-parser", "bin", "python");
  if (!existsSync(pythonBin)) throw new Error("本地 Docling 解析器未安装（缺少 .venv-atlas-parser）");
  onProgress("parsing", "正在使用本地 Docling 解析论文");
  const timeoutMs = Math.max(60000, Number(process.env.TRANSLATION_LOCAL_PARSE_TIMEOUT_MS || 10 * 60 * 1000));
  const { stdout } = await execFileAsync(pythonBin, [
    path.join(process.cwd(), "scripts", "parse-paper.py"),
    "--pdf", pdfPath,
    "--output", outputDirectory,
  ], {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      TRANSLATION_ENABLE_FORMULA: process.env.TRANSLATION_ENABLE_FORMULA || "1",
      TRANSLATION_ENABLE_OCR: process.env.TRANSLATION_ENABLE_OCR || "0",
    },
  });
  const lastLine = stdout.trim().split(/\r?\n/).at(-1) || "";
  const manifest = JSON.parse(lastLine);
  if (manifest?.parser !== "docling" || !manifest?.markdown) throw new Error("本地 Docling 解析器没有返回有效 manifest");
  const markdown = await fs.readFile(path.join(outputDirectory, String(manifest.markdown)), "utf8");
  const stats = await pdfExtractionStats(pdfPath);
  const completeness = assessTextExtractionCompleteness(markdown, stats);
  const hashedManifest = await writePdfHashManifest(pdfPath, outputDirectory, {
    ...manifest,
    pages: stats.pages,
    embedded_images: stats.embeddedImages,
    text_chars: completeness.textChars,
  });
  return { markdown, parser: "docling" as const, manifest: hashedManifest, completeness };
}

function pdftotextHeading(line: string) {
  const text = line.trim();
  if (!text || text.length > 100) return null;
  if (/^\d+(?:\.\d+)*\.?\s+[A-Z]/.test(text)) return `## ${text}`;
  if (/^(?:ABSTRACT|INTRODUCTION|(?:BACKGROUND|RELATED WORK)|METHODOLOGY?|METHODS?|RESULTS?|DISCUSSION|CONCLUSION|REFERENCES?|APPENDIX)\s*$/i.test(text)) return `## ${text}`;
  return null;
}

async function pdfExtractionStats(pdfPath: string) {
  const [info, images] = await Promise.all([
    execFileAsync("pdfinfo", [pdfPath], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }).catch(() => null),
    execFileAsync("pdfimages", ["-list", pdfPath], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }).catch(() => null),
  ]);
  const pagesAvailable = info !== null;
  const imagesAvailable = images !== null;
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info?.stdout || "")?.[1] || 0);
  const embeddedImages = (images?.stdout || "").split("\n").filter((line) => /^\s*\d+\s+\d+\s/.test(line)).length;
  const missingTools: string[] = [];
  if (!pagesAvailable) missingTools.push("pdfinfo");
  if (!imagesAvailable) missingTools.push("pdfimages");
  return { pages, embeddedImages, pagesAvailable, imagesAvailable, missingTools };
}

async function runPdftotextParser(pdfPath: string, outputDirectory: string, onProgress: ParserProgress) {
  onProgress("parsing", "Docling 不可用，正在尝试 pdftotext 本地文本提取");
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  const text = stdout.replace(/\f/g, "\n\n").trim();
  if (!text || text.length < 200) throw new Error("PDF 未包含可提取文本，疑似扫描件");
  const markdown = text.split(/\r?\n/).map((line) => pdftotextHeading(line) || line).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const stats = await pdfExtractionStats(pdfPath);
  const completeness = assessTextExtractionCompleteness(markdown, stats);
  const manifest = {
    parser: "pdftotext",
    parser_version: "poppler",
    source_pdf: pdfPath,
    markdown: "source_structured.md",
    assets: [],
    pages: stats.pages,
    embedded_images: stats.embeddedImages,
    text_chars: completeness.textChars,
  };
  await fs.writeFile(path.join(outputDirectory, "source_structured.md"), `${markdown}\n`, "utf8");
  const hashedManifest = await writePdfHashManifest(pdfPath, outputDirectory, manifest);
  return { markdown, parser: "pdftotext" as const, manifest: hashedManifest, completeness };
}

async function parseStructuredPdf(pdfPath: string, sourceUrl: string, outputDirectory: string, onProgress: ParserProgress) {
  const parserMode = (process.env.TRANSLATION_PARSER || "auto").toLowerCase();
  if (parserMode === "docling") {
    const docling = await runDoclingParser(pdfPath, outputDirectory, onProgress);
    if (!docling.completeness.ok) {
      throw new Error(`SOURCE_QUALITY:Docling 解析未通过完整性门禁：${docling.completeness.issues.slice(0, 6).join("；") || "未知完整性错误"}`);
    }
    return docling;
  }
  if (parserMode === "paddleocr" || parserMode === "paddleocr-only") {
    if (!process.env.PADDLEOCR_ACCESS_TOKEN) throw new Error("PADDLEOCR_ACCESS_TOKEN 未配置，且当前 TRANSLATION_PARSER 只允许云端解析");
    return parseWithPaddleOcr(pdfPath, sourceUrl, outputDirectory, onProgress);
  }
  if (parserMode !== "auto") throw new Error(`不支持 TRANSLATION_PARSER=${parserMode}（可用 auto/docling/paddleocr-only）`);
  let local: { markdown: string; parser: string; manifest: Record<string, unknown> } | null = null;
  const localGateIssues: string[] = [];
  try {
    const docling = await runDoclingParser(pdfPath, outputDirectory, onProgress);
    if (inspectSourceQuality(docling.markdown).ok && docling.completeness.ok) return docling;
    const issues = [...docling.completeness.issues, ...inspectSourceQuality(docling.markdown).issues.map((issue) => issue.message)];
    localGateIssues.push(...issues);
    console.warn(`  Docling 解析结果未通过完整性门禁：${issues.slice(0, 4).join("；")}，回退到 PaddleOCR`);
  } catch (error) {
    console.warn(`  Docling 本地解析不可用：${networkErrorDetail(error)}`);
    try {
      const fallback = await runPdftotextParser(pdfPath, outputDirectory, onProgress);
      if (inspectSourceQuality(fallback.markdown).ok && fallback.completeness.ok) {
        local = fallback;
      } else {
        const issues = [...fallback.completeness.issues, ...inspectSourceQuality(fallback.markdown).issues.map((issue) => issue.message)];
        localGateIssues.push(...issues);
        console.warn(`  pdftotext 回退未通过完整性门禁：${issues.slice(0, 4).join("；")}`);
      }
    } catch (fallbackError) {
      console.warn(`  pdftotext 回退失败：${networkErrorDetail(fallbackError)}`);
    }
  }
  if (local) return local;
  if (!process.env.PADDLEOCR_ACCESS_TOKEN) {
    throw new Error(`PADDLEOCR_ACCESS_TOKEN 未配置，且本地解析未通过完整性门禁：${localGateIssues.slice(0, 6).join("；") || "见上方日志"}`);
  }
  return parseWithPaddleOcr(pdfPath, sourceUrl, outputDirectory, onProgress);
}

async function parseAndValidateSource(pdfPath: string, sourceUrl: string, outputDirectory: string, onProgress: ParserProgress) {
  let lastReport: ReturnType<typeof inspectSourceQuality> | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const structured = await parseStructuredPdf(pdfPath, sourceUrl, outputDirectory, onProgress);
    const repaired = repairSourceQuality(structured.markdown);
    const report = inspectSourceQuality(repaired.markdown);
    if (repaired.repairs.length) {
      await fs.writeFile(path.join(outputDirectory, "source_structured.md"), `${repaired.markdown}\n`, "utf8");
      const manifest = { ...structured.manifest, source_repairs: repaired.repairs };
      await fs.writeFile(path.join(outputDirectory, "document.json"), JSON.stringify(manifest, null, 2), "utf8");
      onProgress("source_quality_check", `已自动修复 ${repaired.repairs.length} 个高置信度 OCR 异常`, 0, 0);
    }
    if (report.ok) return { ...structured, markdown: repaired.markdown, manifest: { ...structured.manifest, source_repairs: repaired.repairs } };
    lastReport = report;
    onProgress("source_quality_check", `第 ${attempt} 次版面解析存在 ${report.issues.length} 个源文档质量问题`, 0, 0);
    if (attempt === 1) onProgress("parsing", "正在重新请求云端解析异常页面");
  }
  const detail = lastReport?.issues.map((issue) => issue.message).slice(0, 6).join("；") || "未知质量问题";
  throw new Error(`SOURCE_QUALITY:源文档解析未通过质量门禁：${detail}`);
}

/**
 * PaddleOCR can turn a chart into an HTML table when the chart has many text
 * labels. If its caption says Figure, recover the embedded PDF image before
 * building the IR. This is image extraction only (not local OCR/parsing); the
 * recovered image still goes through the Qwen visual reviewer.
 */
const PAPER_CAPTION_NUMBER = String.raw`(?:\d+|[IVXLCDM]+)`;
const PAPER_CAPTION_PATTERN_SOURCE = `\\b(Figure|Fig\\.?|Table|图|表)\\s*${PAPER_CAPTION_NUMBER}\\s*[.:：-]`;
const PAPER_CAPTION_PATTERN = new RegExp(PAPER_CAPTION_PATTERN_SOURCE, "gi");

function isAuxiliaryPlotTable(html: string) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").toLowerCase();
  const coordinateHeader = /\bx\s*\[?\s*m\s*\]?/.test(text) && /\by\s*\[?\s*m\s*\]?/.test(text);
  const plotLabel = /(black\s+line|red\s+line|reference|pred(?:icted)?\s+traj|gt\s+traj)/.test(text);
  const rowCount = (html.match(/<tr\b/gi) || []).length;
  return coordinateHeader && (plotLabel || rowCount >= 8);
}

async function recoverFigureTablesFromPdf(markdown: string, pdfPath: string, outputDirectory: string) {
  const recovered: Array<{ id: string; source_table_id: string; page: number; asset: string }> = [...markdown.matchAll(/assets\/page-(\d+)-recovered-(\d+)\.(png|jpg|jpeg)/gi)].map((match) => ({
    id: `figure-recovered-${match[1]}-${match[2]}`,
    source_table_id: `table-${match[2].padStart(3, "0")}`,
    page: Number(match[1]),
    asset: `assets/page-${match[1]}-recovered-${match[2]}.${match[3]}`,
  }));
  const pages = markdown.split(/\n{2,}---\n{2,}/);
  const assetsDirectory = path.join(outputDirectory, "assets");
  await fs.mkdir(assetsDirectory, { recursive: true });
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageNumber = pageIndex + 1;
    const tableMatches = [...pages[pageIndex].matchAll(/<table\b[\s\S]*?<\/table>/gi)];
    const figureGroups = new Map<string, { captionIndex: number; matches: RegExpMatchArray[] }>();
    const captions = [...pages[pageIndex].matchAll(PAPER_CAPTION_PATTERN)];
    for (const match of tableMatches) {
      const start = match.index || 0;
      const end = start + match[0].length;
      const auxiliaryPlot = isAuxiliaryPlotTable(match[0]);
      const nearest = captions
        .map((caption) => {
          const index = caption.index || 0;
          const distance = index >= end ? index - end : start - (index + caption[0].length);
          return { caption, index, distance };
        })
        .filter((item) => item.distance >= 0)
        .sort((left, right) => left.distance - right.distance)[0];
      const figureNearest = auxiliaryPlot
        ? captions
          .map((caption) => {
            const index = caption.index || 0;
            const distance = index >= end ? index - end : start - (index + caption[0].length);
            return { caption, index, distance };
          })
          .filter((item) => item.distance >= 0 && /^(?:Figure|Fig\.?|图)$/i.test(item.caption[1] || ""))
          .sort((left, right) => left.distance - right.distance)[0]
        : nearest;
      if (!figureNearest || !/^(?:Figure|Fig\.?|图)$/i.test(figureNearest.caption[1] || "")) continue;
      const key = `${figureNearest.index}:${figureNearest.caption[0]}`;
      const group = figureGroups.get(key) || { captionIndex: figureNearest.index, matches: [] };
      group.matches.push(match);
      figureGroups.set(key, group);
    }
    const visualGroups = [...figureGroups.values()].sort((left, right) => left.captionIndex - right.captionIndex);
    if (!visualGroups.length) continue;
    const temporaryPrefix = path.join(outputDirectory, `.pdf-image-page-${pageNumber}`);
    let candidates: string[] = [];
    try {
      await execFileAsync("pdfimages", ["-f", String(pageNumber), "-l", String(pageNumber), "-png", pdfPath, temporaryPrefix], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
      candidates = (await fs.readdir(outputDirectory))
        .filter((name) => name.startsWith(path.basename(temporaryPrefix)) && /\.png$/i.test(name))
        .map((name) => path.join(outputDirectory, name));
      let best: string | null = null;
      if (candidates.length) {
        const sizes = await Promise.all(candidates.map(async (file) => ({ file, size: (await fs.stat(file)).size })));
        best = sizes.sort((left, right) => right.size - left.size)[0].file;
      } else {
        // Vector charts have no image XObject for pdfimages to extract. Render
        // the source page instead of treating a valid PDF as a hard failure.
        const renderedPrefix = path.join(outputDirectory, `.pdf-render-page-${pageNumber}`);
        const renderedPage = `${renderedPrefix}.png`;
        try {
          await execFileAsync("pdftoppm", ["-f", String(pageNumber), "-l", String(pageNumber), "-png", "-r", "180", "-singlefile", pdfPath, renderedPrefix], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
          if (existsSync(renderedPage)) best = renderedPage;
        } catch (error) {
          console.warn(`  PDF 第 ${pageNumber} 页没有嵌入位图，页面渲染兜底失败：${networkErrorDetail(error)}`);
        }
      }
      if (!best) {
        console.warn(`  PDF 第 ${pageNumber} 页的图表没有可用视觉资源，保留 OCR 结构供后续语义复核`);
        continue;
      }
      const pageEdits: Array<{ start: number; end: number; value: string }> = [];
      for (let recoveredIndex = 0; recoveredIndex < visualGroups.length; recoveredIndex += 1) {
        const group = visualGroups[recoveredIndex];
        const sourceTableId = `table-${String(recoveredIndex + 1).padStart(3, "0")}`;
        const recoveredId = `figure-recovered-${pageNumber}-${recoveredIndex + 1}`;
        const asset = `assets/page-${pageNumber}-recovered-${recoveredIndex + 1}.png`;
        await fs.copyFile(best, path.join(outputDirectory, asset));
        const first = group.matches[0];
        pageEdits.push({ start: first.index || 0, end: (first.index || 0) + first[0].length, value: `![Image](${asset})` });
        for (const match of group.matches.slice(1)) {
          pageEdits.push({ start: match.index || 0, end: (match.index || 0) + match[0].length, value: "" });
        }
        recovered.push({ id: recoveredId, source_table_id: sourceTableId, page: pageNumber, asset });
      }
      pages[pageIndex] = pageEdits.sort((left, right) => right.start - left.start)
        .reduce((page, edit) => `${page.slice(0, edit.start)}${edit.value}${page.slice(edit.end)}`, pages[pageIndex]);
      if (best.endsWith(".png") && best.includes(`${path.sep}.pdf-render-page-`)) await fs.rm(best, { force: true });
    } finally {
      await Promise.all(candidates.map((file) => fs.rm(file, { force: true })));
    }
  }
  return { markdown: pages.join("\n\n---\n\n"), recovered };
}

async function repairReusableSource(markdown: string, outputDirectory: string, manifest: Record<string, unknown>): Promise<{ markdown: string; manifest: Record<string, unknown> }> {
  const repaired = repairSourceQuality(markdown);
  if (!repaired.repairs.length) return { markdown, manifest };
  const nextManifest = { ...manifest, source_repairs: repaired.repairs };
  await fs.writeFile(path.join(outputDirectory, "source_structured.md"), `${repaired.markdown}\n`, "utf8");
  await fs.writeFile(path.join(outputDirectory, "document.json"), JSON.stringify(nextManifest, null, 2), "utf8");
  return { markdown: repaired.markdown, manifest: nextManifest };
}

async function tryReuseParsedSource(pdfPath: string, outputDirectory: string, sourceUrl: string, onProgress: ParserProgress) {
  if (process.env.TRANSLATION_FORCE === "1") return null;
  try {
    const [manifestRaw, markdown] = await Promise.all([
      fs.readFile(path.join(outputDirectory, "document.json"), "utf8"),
      fs.readFile(path.join(outputDirectory, "source_structured.md"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    if (!manifest?.parser || !markdown.trim()) return null;
    const currentHash = createHash("sha256").update(await fs.readFile(pdfPath)).digest("hex");
    // A missing hash means the cached parse predates provenance tracking; do
    // not "补签名" by trusting it. Treat it as a one-time cache miss.
    if (!manifest.pdf_sha256 || manifest.pdf_sha256 !== currentHash) return null;
    const reusable = await repairReusableSource(markdown, outputDirectory, { ...manifest, pdf_sha256: currentHash });
    if (!inspectSourceQuality(reusable.markdown).ok) return null;
    if (manifest.parser === "docling" || manifest.parser === "pdftotext") {
      const stats = await pdfExtractionStats(pdfPath);
      const completeness = assessTextExtractionCompleteness(reusable.markdown, stats);
      if (!completeness.ok) return null;
    }
    onProgress("parsing", `正在复用已有的 ${String(manifest.parser)} 结构化解析结果`);
    return { text: reusable.markdown, url: sourceUrl, pdfPath, parser: String(manifest.parser), manifest: reusable.manifest };
  } catch {
    return null;
  }
}

async function extractPdf(urls: string[], outputDirectory: string, onProgress: ParserProgress) {
  let lastError = "没有找到可解析的 PDF";
  const cachedPdfPath = path.join(outputDirectory, "source.pdf");
  let cachedBytes: Buffer | null = null;
  try {
    cachedBytes = await fs.readFile(cachedPdfPath);
  } catch {
    // No valid cached PDF: continue through remote candidates.
  }
  if (cachedBytes && cachedBytes.subarray(0, 4).toString() === "%PDF") {
    const sourceUrl = urls[0] || "本地已校验 PDF 缓存";
    onProgress("downloading", "正在复用已校验的 PDF 缓存");
    const reused = await tryReuseParsedSource(cachedPdfPath, outputDirectory, sourceUrl, onProgress);
    if (reused) return reused;
    const structured = await parseAndValidateSource(cachedPdfPath, sourceUrl, outputDirectory, onProgress);
    return { text: structured.markdown, url: sourceUrl, pdfPath: cachedPdfPath, parser: structured.parser, manifest: structured.manifest };
  }
  const candidates = [...new Set(urls.filter(Boolean))];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const url = candidates[candidateIndex];
    let response: Response;
    try {
      onProgress("downloading", `正在下载 PDF（来源 ${candidateIndex + 1}/${candidates.length}）`);
      response = await fetchWithRetry(url, {
        headers: { Accept: "application/pdf", "User-Agent": "AI-Research-Atlas/0.1" },
      }, {
        attempts: 4,
        timeoutMs: 60000,
        onRetry: ({ attempt, error, status, delayMs }) => {
          console.warn(`  PDF 下载第 ${attempt} 次尝试失败（${error ? networkErrorDetail(error) : `HTTP ${status}`}），${delayMs}ms 后重试`);
        },
      });
    } catch (error) {
      lastError = `来源 ${url} 失败：${networkErrorDetail(error)}`;
      continue;
    }
    if (!response.ok) { lastError = `来源 ${url} 请求失败：HTTP ${response.status}`; continue; }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = `来源 ${url} 读取响应失败：${networkErrorDetail(error)}`;
      continue;
    }
    if (!bytes.subarray(0, 4).toString().startsWith("%PDF")) {
      const discovered = pdfLinksFromLandingHtml(bytes.toString("utf8"), response.url || url);
      for (const pdfUrl of discovered) if (!candidates.includes(pdfUrl)) candidates.push(pdfUrl);
      lastError = discovered.length
        ? `来源 ${url} 是论文落地页，已发现 ${discovered.length} 个 PDF 下载地址`
        : `来源 ${url} 不是 PDF（可能是 DOI 跳转页）`;
      continue;
    }
    const pdfPath = path.join(outputDirectory, "source.pdf");
    await fs.writeFile(pdfPath, bytes);
    const reused = await tryReuseParsedSource(pdfPath, outputDirectory, url, onProgress);
    if (reused) return reused;
    onProgress("parsing", "正在解析版面、公式、图片和表格；长论文可能需要几分钟");
    // Parse errors intentionally propagate with their real phase/error message;
    // they must not be rewritten as a "PDF 获取失败" download error.
    const structured = await parseAndValidateSource(pdfPath, url, outputDirectory, onProgress);
    return { text: structured.markdown, url, pdfPath, parser: structured.parser, manifest: structured.manifest };
  }
  throw new Error(`PDF 获取失败：已对 ${candidates.length} 个来源自动重试仍无法下载（${lastError}）`);
}

function tokenOccurrenceCount(content: string, token: string) {
  return content.split(token).length - 1;
}

async function translateChunk(chunk: string, index: number | string, total: number, glossary: string, requiredTokens: string[] = [], signal?: AbortSignal) {
  const response = await fetchWithRetry(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, thinking: { type: "disabled" }, temperature: 0.1, max_tokens: 7000, stream: false, messages: [
      { role: "system", content: "你是严谨的中文学术论文翻译助手。" },
      { role: "user", content: translationPrompt(chunk, index, total, glossary) },
    ] }),
    signal,
  }, {
    attempts: 3,
    timeoutMs: 120000,
    retryPost: true,
    retryStatusOnPost: true,
    idempotencyKey: randomUUID(),
    onRetry: ({ attempt, error, status, delayMs }) => {
      console.warn(`  DeepSeek 第 ${index}/${total} 分块第 ${attempt} 次尝试失败（${error ? networkErrorDetail(error) : `HTTP ${status}`}），${delayMs}ms 后重试`);
    },
  });
  if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json().catch(() => { throw new Error("DeepSeek 返回了无法解析的 JSON"); });
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek 返回空译文");
  const invalidTokens = requiredTokens.filter((token) => tokenOccurrenceCount(content, token) !== 1);
  if (invalidTokens.length) throw new Error(`第 ${index}/${total} 分块中，DeepSeek 改写或遗漏了 ${invalidTokens.length} 个公式/图片/表格占位符`);
  const inventedTokens = findUnknownProtectedTokens(content, requiredTokens);
  if (inventedTokens.length) throw new Error(`第 ${index}/${total} 分块中，DeepSeek 新增了 ${inventedTokens.length} 个不存在的公式/图片/表格占位符`);
  // Source formulas are protected as placeholders. Allow the model to wrap
  // bare variables such as b or T in inline math, but reject newly invented
  // display/complex formulas early so the chunk can be retried safely.
  if (/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/.test(content)) throw new Error(`第 ${index}/${total} 分块中，DeepSeek 新增了原文不存在的块级公式`);
  return content.trim();
}

async function translatePaperTitle(title: string) {
  const response = await fetchWithRetry(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, thinking: { type: "disabled" }, temperature: 0.1, max_tokens: 160, stream: false, messages: [
      { role: "system", content: "你是中文科研论文标题翻译助手。只输出一个准确、简洁的中文标题，不要输出原文、引号、解释、作者或链接。模型名、数据集名和缩写保留。" },
      { role: "user", content: `请将下面的英文论文标题翻译成简体中文：\n${title}` },
    ] }),
  }, {
    attempts: 3,
    timeoutMs: 60000,
    retryPost: true,
    retryStatusOnPost: true,
    idempotencyKey: randomUUID(),
    onRetry: ({ attempt, error, status, delayMs }) => {
      console.warn(`  DeepSeek 标题翻译第 ${attempt} 次尝试失败（${error ? networkErrorDetail(error) : `HTTP ${status}`}），${delayMs}ms 后重试`);
    },
  });
  if (!response.ok) throw new Error(`DeepSeek 标题翻译 ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json().catch(() => { throw new Error("DeepSeek 标题翻译返回了无法解析的 JSON"); });
  const content = data.choices?.[0]?.message?.content;
  const translated = typeof content === "string"
    ? content.replace(/^\s*```[^\n]*\n?|\n?```\s*$/g, "").replace(/^标题\s*[:：]\s*/i, "").trim().split(/\r?\n/)[0]
    : "";
  if (!translated || !/[\u4e00-\u9fff]/.test(translated)) throw new Error("标题翻译没有返回中文标题");
  return translated;
}

async function translateStructuredChunk(chunk: string, index: number | string, total: number, glossary: string, depth = 0, signal?: AbortSignal): Promise<string> {
  const protectedChunk = protectStructuredMarkdown(chunk);
  const tokenOnly = protectedChunk.text.trim().split(/\s+/).every((part) => /^\[\[ATLAS_(?:MATH|ASSET|TABLE|CAPTION|BIND)_\d{6}\]\]$/.test(part));
  if (protectedChunk.protectedTokens.length && tokenOnly) return chunk;
  try {
    const translated = await translateChunk(protectedChunk.text, index, total, glossary, protectedChunk.protectedTokens.map((item) => item.token), signal);
    const restored = unwrapReferenceMathBlocks(restoreStructuredMarkdown(normalizeTranslatedMarkdown(translated), protectedChunk.protectedTokens));
    if (/\[\[ATLAS_[A-Z]+_\d{6}\]\]/.test(restored)) {
      throw new Error(`第 ${index}/${total} 分块中仍有未恢复的结构化占位符`);
    }
    return restored;
  } catch (error) {
    if (signal?.aborted) throw error;
    const tokenFailure = error instanceof Error && /占位符|新增了原文不存在的(?:块级)?公式/.test(error.message);
    if (!tokenFailure || depth >= 3 || chunk.length < 1800) throw error;
    const targetChars = Math.max(1200, Math.min(3500, Math.floor(chunk.length / 2)));
    const parts = splitTranslationChunks(chunk, targetChars);
    if (parts.length <= 1) throw error;
    const translatedParts: string[] = [];
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      translatedParts.push(await translateStructuredChunk(parts[partIndex], `${index}.${partIndex + 1}`, total, glossary, depth + 1, signal));
    }
    return translatedParts.join("\n\n");
  }
}

type SemanticBindingReview = {
  status: "skipped" | "completed" | "unavailable";
  reviewed: number;
  decisions: Array<{ id: string; semantic_kind: "figure" | "table" | "table_image" | "unknown"; caption_id?: string | null; confidence: number; reason: string }>;
  note: string;
};

/**
 * Review only ambiguous OCR/layout records once per paper. PaddleOCR already
 * returns cropped visual assets, so only those small assets are sent when the
 * semantic decision cannot be made from Markdown metadata alone.
 */
async function reviewStructuredBindings(manifest: ReturnType<typeof buildStructuredBindingManifest>, outputDirectory: string): Promise<SemanticBindingReview> {
  const candidates = manifest.objects.filter((item) => manifest.ambiguous.includes(item.id)).slice(0, 24).map((item) => ({
    id: item.id,
    parser_kind: item.kind,
    asset: item.asset || null,
    caption: item.captionText || null,
    caption_kind: item.captionKind || null,
    caption_number: item.captionNumber || null,
    object_excerpt: item.kind === "table"
      ? item.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260)
      : item.text.replace(/\s+/g, " ").trim().slice(0, 160),
    distance: item.distance ?? null,
  }));
  if (!candidates.length || process.env.TRANSLATION_SEMANTIC_REVIEW === "0") {
    return { status: "skipped", reviewed: 0, decisions: [], note: "没有发现需要语义复核的图表绑定" };
  }
  try {
    const visualResults = await Promise.all(candidates.map(async (candidate) => {
      const binding = manifest.objects.find((item) => item.id === candidate.id);
      if (!binding?.asset || !binding.asset.startsWith("assets/")) return null;
      try {
        return await reviewVisualAsset(candidate.id, binding.asset, outputDirectory, candidate.caption || "");
      } catch (error) {
        console.warn(`  PaddleOCR 视觉语义审校失败（${candidate.id}）：${networkErrorDetail(error)}`);
        return null;
      }
    }));
    const visualById = new Map(visualResults.filter(Boolean).map((item) => [item!.id, item!]));
    const captionMetadata = manifest.captions.map((caption) => ({ id: caption.id, kind: caption.kind, number: caption.number, text: caption.text.slice(0, 320) }));
    const metadata = JSON.stringify({ objects: candidates.map((candidate) => ({ ...candidate, visual_kind: visualById.get(candidate.id)?.semantic_kind || null, visual_confidence: visualById.get(candidate.id)?.confidence || null })), captions: captionMetadata });
    // DeepSeek's public chat endpoint is text-only (image_url returns HTTP 400).
    // PaddleOCR-VL supplies visual classification; DeepSeek resolves caption IDs
    // from compact structural metadata only.
    const messageContent = `请审校下面 ${candidates.length} 个视觉对象，并为每个对象选择正确的对象类型和题注 ID。visual_kind 是 PaddleOCR-VL 对裁剪图的版面识别结果，应优先采用；原生 HTML 表格标记为 table；表格截图标记为 table_image；普通图片标记为 figure。返回格式：[${JSON.stringify({ id: "figure-001", semantic_kind: "figure|table|table_image|unknown", caption_id: "caption-001", confidence: 0.9, reason: "不超过20字" })}]。caption_id 必须来自 captions 列表；无法确定时用 null。不要输出 Markdown 或解释。\n${metadata}`;
    const response = await fetchWithRetry(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.DEEPSEEK_SEMANTIC_MODEL || model, thinking: { type: "disabled" }, temperature: 0, max_tokens: 2200, stream: false, messages: [
        { role: "system", content: "你是论文版面结构审校器。结合 OCR/Markdown 元数据和 PaddleOCR-VL 的 visual_kind 判断对象是 figure、table、table_image 或 unknown。只输出 JSON 数组。" },
        { role: "user", content: messageContent },
      ] }),
    }, {
      attempts: 2,
      timeoutMs: 30000,
      retryPost: true,
      retryStatusOnPost: true,
      idempotencyKey: randomUUID(),
      onRetry: ({ attempt, error, status, delayMs }) => {
        console.warn(`  DeepSeek 语义审校第 ${attempt} 次尝试失败（${error ? networkErrorDetail(error) : `HTTP ${status}`}），${delayMs}ms 后重试`);
      },
    });
    if (!response.ok) throw new Error(`DeepSeek 语义审校 ${response.status}`);
    const data = await response.json();
    const responseContent = data.choices?.[0]?.message?.content;
    const jsonText = typeof responseContent === "string" ? responseContent.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim() : "";
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    const parsedValue = JSON.parse(arrayMatch?.[0] || jsonText);
    const parsed = Array.isArray(parsedValue) ? parsedValue : parsedValue?.decisions;
    if (!Array.isArray(parsed)) throw new Error("语义审校返回格式不是数组");
    const allowed = new Set(candidates.map((item) => item.id));
    const allowedCaptions = new Set(manifest.captions.map((caption) => caption.id));
    const textDecisions = parsed.filter((item: any) => item && allowed.has(item.id) && ["figure", "table", "table_image", "unknown"].includes(item.semantic_kind)).map((item: any) => ({
      id: String(item.id),
      semantic_kind: item.semantic_kind as "figure" | "table" | "table_image" | "unknown",
      caption_id: typeof item.caption_id === "string" && allowedCaptions.has(item.caption_id) ? item.caption_id : null,
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
      reason: String(item.reason || "").slice(0, 40),
    }));
    const decisions = candidates.map((candidate) => {
      const textDecision = textDecisions.find((item) => item.id === candidate.id);
      const visualDecision = visualById.get(candidate.id);
      if (visualDecision) return { ...visualDecision, caption_id: null, confidence: Math.max(visualDecision.confidence, textDecision?.confidence || 0), reason: textDecision?.reason || visualDecision.reason };
      // DeepSeek is text-only here; its caption IDs are advisory and can be
      // confused by OCR label order. Stable source order performs the final
      // one-to-one binding below, so never let a model ID steal a later caption.
      return textDecision ? { ...textDecision, caption_id: null } : undefined;
    }).filter(Boolean) as SemanticBindingReview["decisions"];
    const visualProvider = process.env.QWEN_VL_API_KEY || process.env.DASHSCOPE_API_KEY ? "Qwen3-VL-Flash" : "PaddleOCR-VL-1.6";
    return { status: "completed", reviewed: candidates.length, decisions, note: `已用 ${visualProvider} 审校 ${visualById.size} 个裁剪图，并用 DeepSeek 解析题注绑定；不向 DeepSeek 上传整篇论文` };
  } catch (error) {
    return { status: "unavailable", reviewed: candidates.length, decisions: [], note: `语义审校不可用，已回退确定性绑定：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main() {
  loadLocalEnv();
  dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");
  model = process.env.DEEPSEEK_TRANSLATION_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  apiBaseUrl = process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com";
  concurrency = Math.max(1, Math.min(4, Number(process.env.TRANSLATION_CONCURRENCY || 2)));
  const leaseMinutes = Math.max(10, Number(process.env.TRANSLATION_LEASE_MINUTES || 15));
  const paperId = Number(process.argv[process.argv.indexOf("--paper-id") + 1]);
  if (!Number.isInteger(paperId) || paperId <= 0) throw new Error("用法：tsx scripts/translate-paper.ts --paper-id <id>");
  const db = new Database(dbPath);
  ensureResearchFeatureSchema(db);
  const paper = db.prepare("SELECT id, title, abstract, authors, pdf_url, doi, arxiv_id, normalized_title FROM papers WHERE id = ?").get(paperId) as any;
  if (!paper) throw new Error("论文不存在");
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY 未配置");
  const terminologyPath = path.join(process.cwd(), ".codex", "skills", "atlas-paper-translate", "references", "terminology.md");
  const glossary = existsSync(terminologyPath) ? await fs.readFile(terminologyPath, "utf8") : "# 术语表\n\n以论文原文为准。\n";
  const sourceHash = translationSourceHash(paper, {
    model,
    parser: process.env.TRANSLATION_PARSER || "auto",
    formulaEnabled: process.env.TRANSLATION_ENABLE_FORMULA || "1",
    glossary,
  });
  const outputDirectory = path.join(process.cwd(), translationDirectory(paperId));
  let jobToken = process.env.TRANSLATION_JOB_TOKEN || "";
  if (!jobToken) {
    // Direct CLI runs are a formal entry point: claim a managed row so the
    // worker is fenced like an API-started job, and so artifacts are never
    // produced without a paper_translations record.
    const claim = claimTranslationJob(db, paperId, sourceHash, translationDirectory(paperId));
    if (!claim.claimed || !claim.jobToken) {
      throw new Error("无法启动直接翻译：该论文已有活动任务（pending/running），请通过 API 发起或等待其完成");
    }
    jobToken = claim.jobToken;
  }
  activeJobToken = jobToken;
  const started = startTranslationJob(db, paperId, jobToken, process.pid, leaseMinutes);
  if (started.changes !== 1) throw new Error("翻译任务启动失败：job token 已失效或任务已被其他 worker 接管");
  const failureController = new AbortController();
  const updateProgress = (phase: string, message: string, current = 0, total = 0) => {
    const result = updateTranslationProgress(db, paperId, jobToken, leaseMinutes, phase, message, current, total);
    if (result.changes !== 1) throw new Error("翻译任务所有权校验失败：job token 已失效，停止更新进度");
    return result;
  };
  const heartbeat = setInterval(() => {
    let refreshed: { changes: number } | null = null;
    try {
      refreshed = refreshTranslationLease(db, paperId, jobToken, leaseMinutes);
    } catch {
      // A transient DB failure must not kill the worker; the next heartbeat retries.
      return;
    }
    if (refreshed.changes !== 1) {
      clearInterval(heartbeat);
      failureController.abort(new Error("翻译任务所有权校验失败：job token 已失效，立即停止"));
    }
  }, 60000);
  heartbeat.unref();
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.rm(path.join(outputDirectory, "translation_zh.md"), { force: true });
  await fs.rm(path.join(outputDirectory, "translation_candidate.md"), { force: true });
  const alternatives = paper.normalized_title
    ? db.prepare("SELECT pdf_url, arxiv_id FROM papers WHERE normalized_title = ? AND id != ?").all(paper.normalized_title, paper.id) as { pdf_url?: string | null; arxiv_id?: string | null }[]
    : [];
  const candidates = translationUrlCandidates(paper, alternatives);
  updateProgress("starting", "翻译进程已启动，正在准备论文源文件");
  const extracted = await extractPdf(candidates, outputDirectory, (phase, message, current = 0, total = 0) => updateProgress(phase, message, current, total));
  updateProgress("translating", "正在准备结构绑定和中文标题");
  const recoveredSource = await recoverFigureTablesFromPdf(extracted.text, extracted.pdfPath, outputDirectory);
  if (recoveredSource.recovered.length) {
    await fs.writeFile(path.join(outputDirectory, "source_structured.md"), `${recoveredSource.markdown}\n`, "utf8");
    updateProgress("binding_review", `已从原 PDF 恢复 ${recoveredSource.recovered.length} 个疑似图表，并准备视觉审校`);
  }
  const extractedManifest = { ...extracted.manifest, recovered_visuals: recoveredSource.recovered };
  const preparedSource = prepareTranslationSource(recoveredSource.markdown, paper.title);
  const bindingManifest = buildStructuredBindingManifest(preparedSource);
  if (bindingManifest.ambiguous.length) updateProgress("binding_review", `正在对 ${bindingManifest.ambiguous.length} 个歧义图表做一次轻量语义审校`);
  const [translatedTitle, semanticReview] = await Promise.all([
    translatePaperTitle(paper.title),
    reviewStructuredBindings(bindingManifest, outputDirectory),
  ]);
  applySemanticBindingDecisions(bindingManifest, semanticReview.decisions);
  if (bindingManifest.ambiguous.length) {
    assertTranslationOwnership(db, paperId, jobToken, leaseMinutes);
    await fs.writeFile(path.join(outputDirectory, "structure_manifest.json"), JSON.stringify({ ...bindingManifest, semantic_review: semanticReview, phase: "binding_review" }, null, 2), "utf8");
    throw new Error(`STRUCTURE_QUALITY:图表绑定仍有 ${bindingManifest.ambiguous.length} 个歧义对象，未发布译文`);
  }
  const boundSource = normalizeBoundCaptionPlacement(preparedSource, bindingManifest);
  const resolvedManifest = buildStructuredBindingManifest(boundSource);
  applySemanticBindingDecisions(resolvedManifest, semanticReview.decisions);
  if (resolvedManifest.ambiguous.length) {
    assertTranslationOwnership(db, paperId, jobToken, leaseMinutes);
    await fs.writeFile(path.join(outputDirectory, "structure_manifest.json"), JSON.stringify({ ...resolvedManifest, semantic_review: semanticReview, phase: "binding_review" }, null, 2), "utf8");
    throw new Error(`STRUCTURE_QUALITY:图表绑定在重新排版后仍有 ${resolvedManifest.ambiguous.length} 个歧义对象，未发布译文`);
  }
  const source = annotateStructuredBindings(boundSource, resolvedManifest);
  const documentIR = buildDocumentIR(boundSource, resolvedManifest);
  const chunkChars = Math.max(3000, Math.min(9000, Number(process.env.TRANSLATION_CHUNK_CHARS || 6000)));
  const chunks = splitTranslationChunks(source, chunkChars);
  const chunkDirectory = path.join(outputDirectory, "chunks");
  const forceTranslation = process.env.TRANSLATION_FORCE === "1";
  await fs.mkdir(chunkDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, "source.md"), `# ${paper.title}\n\n来源：${extracted.url}\n\n解析器：${extracted.parser}\n\n---\n\n${source}\n`, "utf8");
  await fs.writeFile(path.join(outputDirectory, "glossary.md"), glossary, "utf8");
  const metadataResult = updateTranslationJobMetadata(db, paperId, jobToken, leaseMinutes, {
    sourceHash,
    sourceUrl: extracted.url,
    outputDir: translationDirectory(paperId),
    sourceChars: source.length,
    progressMessage: `正在翻译 0/${chunks.length} 个章节分块`,
    progressTotal: chunks.length,
  });
  if (metadataResult.changes !== 1) throw new Error("翻译任务所有权校验失败：job token 已失效，停止写入源字段");

  const results = new Array<string>(chunks.length);
  let cursor = 0;
  let cacheHits = 0;
  let completedChunks = 0;
  const reportChunkProgress = () => {
    completedChunks += 1;
    updateProgress("translating", `正在翻译 ${completedChunks}/${chunks.length} 个章节分块`, completedChunks, chunks.length);
  };
  let failure: unknown = null;
  const worker = async () => {
    while (true) {
      if (failureController.signal.aborted) return;
      const index = cursor++;
      if (index >= chunks.length) return;
      const chunkHash = createHash("sha256").update(`${sourceHash}\n${index}\n${chunks[index]}`).digest("hex").slice(0, 20);
      const chunkPath = path.join(chunkDirectory, `${String(index + 1).padStart(4, "0")}-${chunkHash}.md`);
      if (!forceTranslation && existsSync(chunkPath)) {
        const cached = await fs.readFile(chunkPath, "utf8");
        const cacheIssues = validateTranslatedFragment(chunks[index], cached);
        if (!cacheIssues.length) {
          results[index] = cached;
          cacheHits += 1;
          console.log(`cached ${index + 1}/${chunks.length}`);
          reportChunkProgress();
          continue;
        }
        console.warn(`invalid cache ${index + 1}/${chunks.length}: ${cacheIssues.join("；")}`);
      }
      try {
        results[index] = await translateStructuredChunk(chunks[index], index + 1, chunks.length, glossary, 0, failureController.signal);
      } catch (error) {
        if (failureController.signal.aborted) return;
        failure = error;
        failureController.abort();
        throw error;
      }
      const temporaryChunkPath = `${chunkPath}.tmp-${process.pid}`;
      await fs.writeFile(temporaryChunkPath, results[index], "utf8");
      await fs.rename(temporaryChunkPath, chunkPath);
      console.log(`translated ${index + 1}/${chunks.length}`);
      reportChunkProgress();
    }
  };
  const workerResults = await Promise.allSettled(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  if (failure) throw failure;
  const workerFailure = workerResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (workerFailure) throw workerFailure.reason;
  updateProgress("validating", "翻译完成，正在校验章节、公式、图片和表格", chunks.length, chunks.length);
  const translatedBodyWithBindings = numberReferenceSection(normalizeTranslatedStructureLabels(normalizeTranslatedMarkdown(restoreHeadingLayout(source, normalizeExtraNumberedHeadings(source, restoreBindingOrder(source, results.join("\n\n").replace(/\n{3,}/g, "\n\n").trim())))), true));
  const validationMarkdown = `# ${translatedTitle}\n\n${translatedBodyWithBindings}`.trim();
  const validationIssues = validateTranslatedMarkdown(source, validationMarkdown, translatedTitle);
  const pdfAuthorNames = extractPaperAuthorAffiliations(extracted.text).map((entry) => entry.name);
  const dbAuthorNames = String(paper.authors || "").split(/[,;]/).map((name) => name.trim()).filter(Boolean);
  const authorConflict = pdfAuthorNames.length > 0 && dbAuthorNames.length > 0
    ? compareAuthorSources(pdfAuthorNames, dbAuthorNames)
    : null;
  if (authorConflict?.conflicting) {
    validationIssues.push(`作者源冲突：PDF 独有 ${authorConflict.pdfOnly.join("、") || "无"}，数据库独有 ${authorConflict.dbOnly.join("、") || "无"}`);
  }
  const finalMarkdown = stripStructuredBindingMarkers(validationMarkdown).replace(/\n{3,}/g, "\n\n").trim();
  const translationPath = path.join(outputDirectory, "translation_zh.md");
  const candidatePath = path.join(outputDirectory, "translation_candidate.md");
  const reportPath = path.join(outputDirectory, "translation_report.md");
  if (failureController.signal.aborted) throw failureController.signal.reason;
  assertTranslationOwnership(db, paperId, jobToken, leaseMinutes);
  const temporaryTranslationPath = `${translationPath}.tmp-${process.pid}`;
  const temporaryCandidatePath = `${candidatePath}.tmp-${process.pid}`;
  const temporaryReportPath = `${reportPath}.tmp-${process.pid}`;
  await fs.writeFile(path.join(outputDirectory, "structure_manifest.json"), JSON.stringify({ ...resolvedManifest, document_ir: documentIR, parser_manifest: extractedManifest, semantic_review: semanticReview }, null, 2), "utf8");
  await fs.writeFile(path.join(outputDirectory, "translation_meta.json"), JSON.stringify({
    title_original: paper.title,
    title_zh: translatedTitle,
    authors: paper.authors || "",
    author_affiliations: extractPaperAuthorAffiliations(extracted.text),
    affiliations: extractPaperAffiliations(extracted.text, paper.title),
    author_source_conflict: authorConflict?.conflicting || false,
    author_source_conflict_detail: authorConflict?.conflicting ? { pdf_only: authorConflict.pdfOnly, db_only: authorConflict.dbOnly } : null,
    source_url: extracted.url,
  }, null, 2), "utf8");
  if (validationIssues.length) {
    await fs.writeFile(temporaryCandidatePath, `${finalMarkdown}\n`, "utf8");
    await fs.rename(temporaryCandidatePath, candidatePath);
    await fs.rm(translationPath, { force: true });
  } else {
    await fs.writeFile(temporaryTranslationPath, `${finalMarkdown}\n`, "utf8");
    await fs.rename(temporaryTranslationPath, translationPath);
    await fs.rm(candidatePath, { force: true });
  }
  const assetCount = Array.isArray((extractedManifest as { assets?: unknown[] } | undefined)?.assets) ? (extractedManifest as { assets: unknown[] }).assets.length + recoveredSource.recovered.length : recoveredSource.recovered.length;
  await fs.writeFile(temporaryReportPath, `# 翻译报告\n\n- 中文标题：${translatedTitle}\n- 模型：${model}\n- PDF 解析器：${extracted.parser}\n- 原文字符数：${source.length}\n- 译文字符数：${finalMarkdown.length}\n- 分块数：${chunks.length}\n- 分块缓存命中：${cacheHits}\n- 并发数：${concurrency}\n- 图片资源：${assetCount}\n- 图表绑定块：${resolvedManifest.objects.length}\n- 语义审校：${semanticReview.status}（${semanticReview.reviewed} 条）\n- 结构校验：${validationIssues.length ? validationIssues.join("；") : "通过"}\n- 说明：译文保留论文中的公式、代码、引用键、数据集名和模型名；图表题注通过稳定绑定 ID 校验，歧义对象仅上传裁剪图进行语义审校；从原 PDF 恢复图像 ${recoveredSource.recovered.length} 个。${semanticReview.note}\n`, "utf8");
  await fs.rename(temporaryReportPath, reportPath);
  const status = validationIssues.length ? "needs_review" : "completed";
  const validationError = validationIssues.length ? validationIssues.join("；") : null;
  finishTranslationJob(db, paperId, jobToken, {
    status,
    error: validationError,
    progressPhase: status,
    progressMessage: status === "completed" ? "翻译和结构校验已完成" : "翻译已生成，但结构校验需要人工复核",
    translatedChars: finalMarkdown.length,
    progressCurrent: chunks.length,
    progressTotal: chunks.length,
  });
  clearInterval(heartbeat);
  db.close();
}

main().catch(async (error) => {
  const paperId = Number(process.argv[process.argv.indexOf("--paper-id") + 1]);
  if (Number.isInteger(paperId) && paperId > 0) {
    const db = new Database(dbPath);
    ensureResearchFeatureSchema(db);
    const jobToken = activeJobToken || process.env.TRANSLATION_JOB_TOKEN || "";
    const message = error instanceof Error ? error.message : String(error);
    const needsReview = /^(?:SOURCE_QUALITY|STRUCTURE_QUALITY):/.test(message);
    const structureIssue = /^STRUCTURE_QUALITY:/.test(message);
    const cleanMessage = message.replace(/^(?:SOURCE_QUALITY|STRUCTURE_QUALITY):\s*/, "");
    finishTranslationJob(db, paperId, jobToken, {
      status: needsReview ? "needs_review" : "failed",
      error: cleanMessage,
      progressPhase: needsReview ? (structureIssue ? "binding_review" : "source_quality_check") : "failed",
      progressMessage: cleanMessage,
    });
    db.close();
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
