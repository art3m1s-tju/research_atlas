import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureResearchFeatureSchema } from "@/lib/research-features";

const DB_PATH = path.join(process.cwd(), "data", "atlas.db");
const execFileAsync = promisify(execFile);

function parseJson(value: string | null, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function buildEvidence(paper: any) {
  const innovations = parseJson(paper.innovations_zh, []);
  return [
    { type: "problem", label: "研究问题", content: paper.summary_zh || paper.abstract || "暂无摘要证据", source: paper.summary_zh ? "缓存的中文解读" : "论文摘要", confidence: paper.abstract ? "medium" : "low" },
    { type: "method", label: "方法", content: paper.method_zh || "摘要未提供足够的方法细节", source: paper.method_zh ? "缓存的中文解读" : "论文摘要缺少结构化方法", confidence: paper.method_zh ? "medium" : "low" },
    { type: "innovation", label: "核心创新", content: innovations.filter((item: string) => item !== "摘要未说明").join("；") || "暂无结构化创新点", source: innovations.length ? "缓存的中文解读" : "论文摘要", confidence: innovations.length ? "medium" : "low" },
    { type: "result", label: "实验结果", content: paper.results_zh || "暂无结构化结果证据", source: paper.results_zh ? "缓存的中文解读" : "尚未解析全文", confidence: paper.results_zh ? "medium" : "low" },
    { type: "limitation", label: "局限性", content: paper.limitations_zh || "暂无结构化局限性证据", source: paper.limitations_zh ? "缓存的中文解读" : "尚未解析全文", confidence: paper.limitations_zh ? "medium" : "low" },
  ];
}

function buildFullTextEvidence(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  const find = (patterns: RegExp[], fallback: string) => {
    for (const pattern of patterns) {
      const match = compact.match(pattern);
      if (match?.[1]) return match[1].slice(0, 1200);
    }
    return fallback;
  };
  return [
    { type: "problem", label: "研究问题", content: find([/(?:introduction|abstract)[.:]?\s*(.{120,1000}?)(?:method|approach|2\s)/i], "全文未识别出明确研究问题"), source: "PDF 全文文本", confidence: "medium" },
    { type: "method", label: "方法", content: find([/(?:methodology|method|approach)[.:]?\s*(.{120,1200}?)(?:experiment|result|evaluation|3\s)/i], "全文未识别出方法章节"), source: "PDF 全文文本", confidence: "medium" },
    { type: "innovation", label: "核心创新", content: find([/(?:our contributions|we propose|contribution)[.:]?\s*(.{120,1200}?)(?:experiment|result|related work)/i], "全文未识别出贡献段落"), source: "PDF 全文文本", confidence: "medium" },
    { type: "result", label: "实验结果", content: find([/(?:experiments?|results?|evaluation)[.:]?\s*(.{120,1200}?)(?:conclusion|discussion|limitation)/i], "全文未识别出实验结果章节"), source: "PDF 全文文本", confidence: "medium" },
    { type: "limitation", label: "局限性", content: find([/(?:limitations?|failure cases?|discussion)[.:]?\s*(.{120,900}?)(?:conclusion|references)/i], "全文未识别出局限性章节"), source: "PDF 全文文本", confidence: "low" },
  ];
}

async function extractPdf(urls: string[]) {
  let lastError = "没有找到可解析的 PDF";
  for (const pdfUrl of urls) {
    try {
      const response = await fetch(pdfUrl, {
        headers: { Accept: "application/pdf", "User-Agent": "AI-Research-Atlas/0.1" },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) { lastError = `PDF 请求失败：${response.status}`; continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.subarray(0, 4).toString().startsWith("%PDF")) { lastError = "数据源返回的不是 PDF"; continue; }
      const temporaryPath = path.join(os.tmpdir(), `ai-research-atlas-${Date.now()}.pdf`);
      await fs.writeFile(temporaryPath, bytes);
      try {
        const result = await execFileAsync("pdftotext", ["-layout", temporaryPath, "-"], { maxBuffer: 4 * 1024 * 1024 });
        return { text: result.stdout, url: pdfUrl };
      } finally {
        await fs.unlink(temporaryPath).catch(() => undefined);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const request = _request;
  const fullText = new URL(request.url).searchParams.get("fulltext") === "1";
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = db.prepare("SELECT * FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as any;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const cached = db.prepare("SELECT evidence_json, source, source_url, generated_at FROM paper_evidence WHERE paper_id = ?").get(paper.id) as any;
    let evidence = cached ? parseJson(cached.evidence_json, []) : buildEvidence(paper);
    let source = cached?.source || "摘要/缓存解读";
    let sourceUrl = cached?.source_url || paper.pdf_url || paper.doi || null;
    if (fullText && paper.pdf_url) {
      try {
        const urls = [paper.pdf_url];
        const arxivId = paper.arxiv_id || String(paper.pdf_url).match(/arxiv\.org\/(?:pdf|abs)\/([^/?#]+)/i)?.[1];
        if (arxivId) urls.push(`https://arxiv.org/pdf/${arxivId.replace(/\.pdf$/, "")}.pdf?download=1`);
        const extracted = await extractPdf([...new Set(urls)]);
        evidence = buildFullTextEvidence(extracted.text);
        source = "PDF 全文文本（pdftotext）";
        sourceUrl = extracted.url;
        db.prepare("INSERT OR REPLACE INTO paper_evidence (paper_id, evidence_json, source, source_url) VALUES (?, ?, ?, ?)")
          .run(paper.id, JSON.stringify(evidence), source, sourceUrl);
      } catch (error) {
        return NextResponse.json({ evidence, source, sourceUrl, warning: error instanceof Error ? error.message : "全文解析失败", note: "全文解析失败，已回退到缓存摘要证据。" });
      }
    }
    if (!cached && !fullText) {
      db.prepare("INSERT OR REPLACE INTO paper_evidence (paper_id, evidence_json, source, source_url) VALUES (?, ?, ?, ?)")
        .run(paper.id, JSON.stringify(evidence), "摘要/缓存解读", paper.pdf_url || paper.doi || null);
    }
    return NextResponse.json({ evidence, source, sourceUrl, generatedAt: new Date().toISOString(), note: source.includes("PDF") ? "证据来自 PDF 文本提取，尚未绑定页码；请结合原文核对。" : "当前证据卡优先使用已缓存的摘要和中文解读。点击全文解析后会尝试从开放 PDF 提取章节文本。" });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.evidence)) return NextResponse.json({ error: "evidence 必须是数组" }, { status: 400 });
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = db.prepare("SELECT id, pdf_url, doi FROM papers WHERE openalex_id = ?").get(decodeURIComponent(id)) as any;
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    db.prepare("INSERT OR REPLACE INTO paper_evidence (paper_id, evidence_json, source, source_url) VALUES (?, ?, ?, ?)")
      .run(paper.id, JSON.stringify(body.evidence), body.source || "外部全文解析", body.sourceUrl || paper.pdf_url || paper.doi || null);
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}
