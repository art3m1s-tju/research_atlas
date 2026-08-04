import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";
import { extractPaperAffiliations, extractPaperAuthorAffiliations, translationDirectory, translationSourceHash, translationUrlCandidates } from "@/lib/paper-translation";
import { claimTranslationJob, expireStaleTranslationJob, failTranslationJob } from "@/lib/translation-job";
import { decodePaperId } from "@/lib/paper-id";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");

function translationRuntime() {
  const terminologyPath = path.join(process.cwd(), ".codex", "skills", "atlas-paper-translate", "references", "terminology.md");
  return {
    model: process.env.DEEPSEEK_TRANSLATION_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    parser: process.env.TRANSLATION_PARSER || "auto",
    formulaEnabled: process.env.TRANSLATION_ENABLE_FORMULA || "1",
    glossary: existsSync(terminologyPath) ? readFileSync(terminologyPath, "utf8") : "# 术语表\n\n以论文原文为准。\n",
  };
}

function paperFromId(db: Database.Database, id: string) {
  return db.prepare("SELECT id, title, abstract, pdf_url, doi, arxiv_id, normalized_title FROM papers WHERE openalex_id = ?").get(decodePaperId(id)) as any;
}

function rewriteAssetReferences(markdown: string, id: string) {
  const assetBase = `/api/papers/${encodeURIComponent(decodePaperId(id))}/translation?asset=`;
  const rewrite = (asset: string) => `${assetBase}${encodeURIComponent(asset.replace(/^\.\//, ""))}`;
  return markdown
    .replace(/(!\[[^\]]*\]\()((?:\.\/)?assets\/[^)\s]+)(\))/g, (_match, prefix: string, asset: string, suffix: string) => `${prefix}${rewrite(asset)}${suffix}`)
    .replace(/(<img\b[^>]*\bsrc=["'])((?:\.\/)?assets\/[^"']+)(["'])/gi, (_match, prefix: string, asset: string, suffix: string) => `${prefix}${rewrite(asset)}${suffix}`);
}

function contentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" } as Record<string, string>)[extension] || "application/octet-stream";
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = paperFromId(db, id);
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const row = db.prepare("SELECT status, source_url, output_dir, error, source_chars, translated_chars, progress_phase, progress_current, progress_total, progress_message, started_at, updated_at FROM paper_translations WHERE paper_id = ?").get(paper.id) as any;
    if (row && ["pending", "running"].includes(row.status) && expireStaleTranslationJob(db, paper.id).changes > 0) {
      row.status = "failed";
      row.error = "翻译任务已过期（worker 可能已崩溃），请重新点击翻译";
      row.lease_expires_at = null;
    }
    const params = new URL(request.url).searchParams;
    const asset = params.get("asset");
    if (asset) {
      if (!row?.output_dir) return NextResponse.json({ error: "翻译资源尚未生成" }, { status: 404 });
      const outputRoot = path.resolve(process.cwd(), row.output_dir);
      const assetPath = path.resolve(outputRoot, asset);
      if (!assetPath.startsWith(`${outputRoot}${path.sep}`) || !assetPath.includes(`${path.sep}assets${path.sep}`)) return NextResponse.json({ error: "资源路径无效" }, { status: 400 });
      const content = await fs.readFile(assetPath).catch(() => null);
      if (content === null) return NextResponse.json({ error: "图片资源不存在" }, { status: 404 });
      return new NextResponse(content, { headers: { "Content-Type": contentType(assetPath), "Cache-Control": "public, max-age=86400" } });
    }
    const file = params.get("file");
    if (file) {
      if (!row?.output_dir || !["source.md", "source_structured.md", "document.json", "translation_zh.md", "translation_candidate.md", "translation_meta.json", "glossary.md", "translation_report.md"].includes(file)) {
        return NextResponse.json({ error: "翻译文件尚未生成" }, { status: 404 });
      }
      if (file === "translation_zh.md" && row.status !== "completed") return NextResponse.json({ error: "正式译文尚未通过结构校验" }, { status: 404 });
      if (file === "translation_candidate.md" && row.status !== "needs_review") return NextResponse.json({ error: "待复核译文尚未生成" }, { status: 404 });
      const content = await fs.readFile(path.join(process.cwd(), row.output_dir, file), "utf8").catch(() => null);
      if (content === null) return NextResponse.json({ error: "翻译文件不存在" }, { status: 404 });
      const renderedContent = file === "translation_zh.md" ? rewriteAssetReferences(content, id) : content;
      return new NextResponse(renderedContent, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `inline; filename="${file}"` } });
    }
    let metadata: Record<string, unknown> | null = null;
    if (row?.output_dir) {
      metadata = JSON.parse(await fs.readFile(path.join(process.cwd(), row.output_dir, "translation_meta.json"), "utf8").catch(() => "null")) as Record<string, unknown> | null;
      const source = await fs.readFile(path.join(process.cwd(), row.output_dir, "source_structured.md"), "utf8").catch(() => "");
      if (source) {
        const affiliations = extractPaperAffiliations(source, paper.title);
        const authorAffiliations = extractPaperAuthorAffiliations(source);
        if (affiliations.length && (!metadata || !Array.isArray(metadata.affiliations) || metadata.affiliations.length === 0)) {
          metadata = { ...(metadata || {}), affiliations };
        }
        if (authorAffiliations.length && (!metadata || !Array.isArray(metadata.author_affiliations) || metadata.author_affiliations.length === 0)) {
          metadata = { ...(metadata || {}), author_affiliations: authorAffiliations };
        }
      }
    }
    return NextResponse.json({ translation: row ? {
      ...row,
      ...(metadata || {}),
      previewUrl: row.status === "completed" ? `/papers/${encodeURIComponent(decodePaperId(id))}/translation` : null,
      markdownUrl: row.status === "completed" ? `/api/papers/${encodeURIComponent(decodePaperId(id))}/translation?file=translation_zh.md` : null,
      candidateUrl: row.status === "needs_review" && row.output_dir && existsSync(path.join(process.cwd(), row.output_dir, "translation_candidate.md"))
        ? `/api/papers/${encodeURIComponent(decodePaperId(id))}/translation?file=translation_candidate.md`
        : null,
    } : null });
  } finally { db.close(); }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const payload = await request.json().catch(() => ({})) as { force?: boolean };
  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = paperFromId(db, id);
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const alternatives = paper.normalized_title
      ? db.prepare("SELECT pdf_url, arxiv_id FROM papers WHERE normalized_title = ? AND id != ?").all(paper.normalized_title, paper.id) as { pdf_url?: string | null; arxiv_id?: string | null }[]
      : [];
    const candidates = translationUrlCandidates(paper, alternatives);
    if (!candidates.length) return NextResponse.json({ error: "这篇论文没有可访问的 PDF，暂时无法生成全文翻译。" }, { status: 400 });
    const sourceHash = translationSourceHash(paper, translationRuntime());
    const existing = db.prepare("SELECT status, source_hash, error, progress_message, lease_expires_at FROM paper_translations WHERE paper_id = ?").get(paper.id) as any;
    if (existing?.status === "completed" && existing.source_hash === sourceHash && !payload.force) {
      return NextResponse.json({ success: true, cached: true, status: existing.status, message: "已存在同版本中文翻译。" });
    }
    const cacheInvalidated = existing?.status === "pending" && String(existing?.progress_message || "").startsWith("旧缓存已失效");
    const leaseExpired = !existing?.lease_expires_at || existing.lease_expires_at < (db.prepare("SELECT datetime('now') AS now").get() as { now: string }).now;
    if (["pending", "running"].includes(existing?.status) && !cacheInvalidated && !leaseExpired) {
      return NextResponse.json({ success: true, cached: false, status: existing.status, message: "翻译任务已在执行。" });
    }
    const claim = claimTranslationJob(db, paper.id, sourceHash, translationDirectory(paper.id));
    if (!claim.claimed) return NextResponse.json({ success: true, cached: false, status: existing?.status || "pending", message: "翻译任务已在执行。" });
    const jobToken = claim.jobToken as string;
    mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
    const logDescriptor = openSync(path.join(process.cwd(), "data", `translation-${paper.id}.log`), "a");
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(command, ["tsx", path.join(process.cwd(), "scripts", "translate-paper.ts"), "--paper-id", String(paper.id)], { cwd: process.cwd(), detached: true, stdio: ["ignore", logDescriptor, logDescriptor], env: { ...process.env, TRANSLATION_FORCE: payload.force ? "1" : "0", TRANSLATION_JOB_TOKEN: jobToken } });
    closeSync(logDescriptor);
    const markFailed = (message: string) => {
      try {
        const recoveryDb = new Database(DB_PATH);
        ensureResearchFeatureSchema(recoveryDb);
        failTranslationJob(recoveryDb, paper.id, jobToken, message);
        recoveryDb.close();
      } catch {
        // The original task row is the source of truth; a late write failure is not worth crashing the API.
      }
    };
    child.on("error", (error) => markFailed(`翻译进程启动失败：${error.message}`));
    child.on("exit", (code) => { if (code !== 0) markFailed(`翻译进程异常退出（退出码 ${code}）`); });
    child.unref();
    return NextResponse.json({ success: true, cached: false, status: "pending", message: "翻译任务已在后台启动，可稍后刷新状态。" });
  } finally { db.close(); }
}
