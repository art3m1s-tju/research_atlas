import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureResearchFeatureSchema } from "../src/lib/research-features";
import { normalizeTranslatedMarkdown, protectStructuredMarkdown, restoreImageLayout, restoreStructuredMarkdown, splitTranslationChunks, translationDirectory, translationPrompt, translationSourceHash, translationUrlCandidates, validateTranslatedMarkdown } from "../src/lib/paper-translation";

const execFileAsync = promisify(execFile);
let dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");
let model = process.env.DEEPSEEK_TRANSLATION_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
let apiBaseUrl = process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com";
let concurrency = Math.max(1, Math.min(4, Number(process.env.TRANSLATION_CONCURRENCY || 2)));

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

function parserPythonCandidates() {
  return [...new Set([
    process.env.TRANSLATION_PYTHON_BIN,
    path.join(process.cwd(), ".venv-atlas-parser", "bin", "python"),
    process.env.PYTHON || "",
    "python3.14",
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
  ].filter((value): value is string => Boolean(value)))];
}

function parserEnvironments() {
  const base = { ...process.env };
  if (process.env.TRANSLATION_PARSER_USE_PROXY === "1") return [base];
  const direct = { ...base };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete direct[key];
  direct.NO_PROXY = "*";
  direct.no_proxy = "*";
  return [direct, base];
}

async function parseStructuredPdf(pdfPath: string, outputDirectory: string) {
  const parserMode = (process.env.TRANSLATION_PARSER || "auto").toLowerCase();
  if (parserMode === "legacy" || parserMode === "pdftotext") return null;
  const parserScript = path.join(process.cwd(), "scripts", "parse-paper.py");
  let lastError = "Docling 解析器不可用";
  for (const parserEnv of parserEnvironments()) {
    for (const python of parserPythonCandidates()) {
      try {
        const { stdout } = await execFileAsync(python, [parserScript, "--pdf", pdfPath, "--output", outputDirectory], { env: parserEnv, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
        const manifestLine = stdout.trim().split("\n").at(-1);
        const manifest = manifestLine ? JSON.parse(manifestLine) : null;
        const markdown = await fs.readFile(path.join(outputDirectory, "source_structured.md"), "utf8");
        if (!manifest || !markdown.trim()) throw new Error("Docling 没有生成结构化 Markdown");
        return { markdown, parser: "docling", manifest };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  if (parserMode === "docling") throw new Error(lastError);
  console.warn(`  Docling 未启用，回退 pdftotext：${lastError}`);
  return null;
}

function insertExtractedImages(text: string, structuredMarkdown: string) {
  const structuredLines = structuredMarkdown.split("\n");
  const imagesByFigure = new Map<number, string[]>();
  const unnumberedImages: string[] = [];
  structuredLines.forEach((line, index) => {
    const pathMatch = line.match(/!\[[^\]]*\]\((assets\/[^)]+)\)/);
    if (!pathMatch) return;
    const context = structuredLines.slice(Math.max(0, index - 8), index).join(" ");
    const numberMatch = context.match(/\b(?:Fig\.?|Figure)\s*(\d+)\b/i);
    if (!numberMatch) { unnumberedImages.push(pathMatch[1]); return; }
    const figureNumber = Number(numberMatch[1]);
    imagesByFigure.set(figureNumber, [...(imagesByFigure.get(figureNumber) || []), pathMatch[1]]);
  });
  if (!imagesByFigure.size && !unnumberedImages.length) return text;
  const lines = text.split("\n");
  let figureSearchStart = 0;
  for (const [figureNumber, imagePaths] of [...imagesByFigure.entries()].sort(([left], [right]) => left - right)) {
    const figurePattern = new RegExp(`\\b(?:Fig\\.?|Figure)\\s*${figureNumber}\\b`, "i");
    let inserted = false;
    for (let lineIndex = figureSearchStart; lineIndex < lines.length; lineIndex += 1) {
      if (!figurePattern.test(lines[lineIndex])) continue;
      lines.splice(lineIndex + 1, 0, "", ...imagePaths.map((imagePath) => `![Image](${imagePath})`), "");
      figureSearchStart = lineIndex + imagePaths.length + 3;
      inserted = true;
      break;
    }
    if (!inserted) lines.push("", ...imagePaths.map((imagePath) => `![Image](${imagePath})`), "");
  }
  if (unnumberedImages.length) lines.push("", ...unnumberedImages.map((imagePath) => `![Image](${imagePath})`), "");
  return lines.join("\n");
}

async function extractPdf(urls: string[], outputDirectory: string) {
  let lastError = "没有找到可解析的 PDF";
  for (const url of [...new Set(urls.filter(Boolean))]) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/pdf", "User-Agent": "AI-Research-Atlas/0.1" }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) { lastError = `PDF 请求失败：${response.status}`; continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.subarray(0, 4).toString().startsWith("%PDF")) { lastError = `数据源不是 PDF：${url}（可能是 DOI 跳转页）`; continue; }
      const pdfPath = path.join(outputDirectory, "source.pdf");
      await fs.writeFile(pdfPath, bytes);
      const structured = await parseStructuredPdf(pdfPath, outputDirectory);
      const result = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], { maxBuffer: 64 * 1024 * 1024 });
      if (structured) return { text: insertExtractedImages(result.stdout, structured.markdown), url, pdfPath, parser: "docling+pdftotext", manifest: structured.manifest };
      return { text: result.stdout, url, pdfPath, parser: "pdftotext", manifest: null };
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
  }
  throw new Error(lastError);
}

async function translateChunk(chunk: string, index: number, total: number) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, thinking: { type: "disabled" }, temperature: 0.1, max_tokens: 7000, stream: false, messages: [
          { role: "system", content: "你是严谨的中文学术论文翻译助手。" },
          { role: "user", content: translationPrompt(chunk, index, total) },
        ] }),
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek 返回空译文");
      return content.trim();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  loadLocalEnv();
  dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");
  model = process.env.DEEPSEEK_TRANSLATION_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  apiBaseUrl = process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com";
  concurrency = Math.max(1, Math.min(4, Number(process.env.TRANSLATION_CONCURRENCY || 2)));
  const paperId = Number(process.argv[process.argv.indexOf("--paper-id") + 1]);
  if (!Number.isInteger(paperId) || paperId <= 0) throw new Error("用法：tsx scripts/translate-paper.ts --paper-id <id>");
  const db = new Database(dbPath);
  ensureResearchFeatureSchema(db);
  const paper = db.prepare("SELECT id, title, abstract, pdf_url, doi, arxiv_id, normalized_title FROM papers WHERE id = ?").get(paperId) as any;
  if (!paper) throw new Error("论文不存在");
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY 未配置");
  const sourceHash = translationSourceHash(paper);
  const outputDirectory = path.join(process.cwd(), translationDirectory(paperId));
  await fs.mkdir(outputDirectory, { recursive: true });
  const alternatives = paper.normalized_title
    ? db.prepare("SELECT pdf_url, arxiv_id FROM papers WHERE normalized_title = ? AND id != ?").all(paper.normalized_title, paper.id) as { pdf_url?: string | null; arxiv_id?: string | null }[]
    : [];
  const candidates = translationUrlCandidates(paper, alternatives);
  const extracted = await extractPdf(candidates, outputDirectory);
  const chunks = splitTranslationChunks(extracted.text);
  await fs.writeFile(path.join(outputDirectory, "source.md"), `# ${paper.title}\n\n来源：${extracted.url}\n\n解析器：${extracted.parser}\n\n---\n\n${extracted.text}\n`, "utf8");
  const terminologyPath = path.join(process.cwd(), ".codex", "skills", "atlas-paper-translate", "references", "terminology.md");
  const glossary = existsSync(terminologyPath) ? await fs.readFile(terminologyPath, "utf8") : "# 术语表\n\n以论文原文为准。\n";
  await fs.writeFile(path.join(outputDirectory, "glossary.md"), glossary, "utf8");
  db.prepare("UPDATE paper_translations SET status = 'running', source_hash = ?, source_url = ?, output_dir = ?, source_chars = ?, translated_chars = 0, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE paper_id = ?").run(sourceHash, extracted.url, translationDirectory(paperId), extracted.text.length, paperId);

  const results = new Array<string>(chunks.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= chunks.length) return;
      const protectedChunk = protectStructuredMarkdown(chunks[index]);
      const translated = await translateChunk(protectedChunk.text, index + 1, chunks.length);
      results[index] = restoreStructuredMarkdown(translated, protectedChunk.protectedTokens);
      console.log(`translated ${index + 1}/${chunks.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  const translated = `# ${paper.title}\n\n> 原文：${extracted.url}\n\n---\n\n${results.map((result) => normalizeTranslatedMarkdown(result)).join("\n\n")}`;
  const finalMarkdown = normalizeTranslatedMarkdown(restoreImageLayout(extracted.text, translated));
  const validationIssues = validateTranslatedMarkdown(extracted.text, finalMarkdown);
  await fs.writeFile(path.join(outputDirectory, "translation_zh.md"), `${finalMarkdown}\n`, "utf8");
  await fs.writeFile(path.join(outputDirectory, "translation_report.md"), `# 翻译报告\n\n- 模型：${model}\n- PDF 解析器：${extracted.parser}\n- 原文字符数：${extracted.text.length}\n- 译文字符数：${finalMarkdown.length}\n- 分块数：${chunks.length}\n- 并发数：${concurrency}\n- 图片资源：${extracted.manifest?.assets?.length ?? 0}\n- 结构校验：${validationIssues.length ? validationIssues.join("；") : "通过"}\n- 说明：译文保留论文中的公式、代码、引用键、数据集名和模型名；使用前请结合原文核对。\n`, "utf8");
  db.prepare("UPDATE paper_translations SET status = 'completed', translated_chars = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE paper_id = ?").run(finalMarkdown.length, paperId);
  db.close();
}

main().catch(async (error) => {
  const paperId = Number(process.argv[process.argv.indexOf("--paper-id") + 1]);
  if (Number.isInteger(paperId) && paperId > 0) {
    const db = new Database(dbPath);
    ensureResearchFeatureSchema(db);
    db.prepare("UPDATE paper_translations SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE paper_id = ?").run(error instanceof Error ? error.message : String(error), paperId);
    db.close();
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
