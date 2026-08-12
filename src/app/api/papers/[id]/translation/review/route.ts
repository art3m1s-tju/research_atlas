import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureResearchFeatureSchema } from "@/lib/research-features";
import { applyHumanBindingDecisions, rebindTranslatedCandidate, type HumanBindingDecision, type StructuredBindingManifest } from "@/lib/paper-translation";
import { decodePaperId } from "@/lib/paper-id";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "atlas.db");

function paperFromId(db: Database.Database, id: string) {
  return db.prepare("SELECT id FROM papers WHERE openalex_id = ?").get(decodePaperId(id)) as { id: number } | undefined;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const payload = await request.json().catch(() => ({})) as { decisions?: HumanBindingDecision[] };
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  if (!decisions.length) return NextResponse.json({ error: "至少选择一个对象和题注的配对" }, { status: 400 });

  const db = new Database(DB_PATH);
  try {
    ensureResearchFeatureSchema(db);
    const paper = paperFromId(db, id);
    if (!paper) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    const row = db.prepare("SELECT status, output_dir FROM paper_translations WHERE paper_id = ?").get(paper.id) as { status: string; output_dir: string | null } | undefined;
    if (!row?.output_dir || row.status !== "needs_review") return NextResponse.json({ error: "当前没有可人工复核的翻译任务" }, { status: 409 });

    const outputDirectory = path.resolve(process.cwd(), row.output_dir);
    const manifestPath = path.join(outputDirectory, "structure_manifest.json");
    const candidatePath = path.join(outputDirectory, "translation_candidate.md");
    const previous = JSON.parse(await fs.readFile(manifestPath, "utf8")) as StructuredBindingManifest & { review_issues?: string[] };
    const candidate = await fs.readFile(candidatePath, "utf8").catch(() => null);
    if (candidate === null) return NextResponse.json({ error: "待复核译文不存在，请重新翻译后再进行人工配对" }, { status: 404 });

    let next: StructuredBindingManifest;
    try {
      next = applyHumanBindingDecisions(previous, decisions);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const updatedCandidate = rebindTranslatedCandidate(candidate, previous, next);
    const previousIssues = Array.isArray(previous.review_issues) ? previous.review_issues : [];
    const reviewIssues = previousIssues.filter((issue) => !issue.startsWith("图表绑定需要人工复核："));
    if (next.ambiguous.length) reviewIssues.push(`图表绑定需要人工复核：${next.ambiguous.join("、")}`);
    await fs.writeFile(candidatePath, updatedCandidate, "utf8");
    await fs.writeFile(manifestPath, JSON.stringify({
      ...previous,
      ...next,
      review_required: true,
      review_issues: reviewIssues,
      manual_review: { decisions, updated_at: new Date().toISOString() },
    }, null, 2), "utf8");

    const message = next.ambiguous.length
      ? `已保存人工配对，仍有 ${next.ambiguous.length} 个对象需要判断`
      : "已保存人工图表配对；译文仍保留待复核状态，请继续检查正文和表格数值";
    db.prepare("UPDATE paper_translations SET status = 'needs_review', error = ?, progress_phase = 'needs_review', progress_message = ?, updated_at = CURRENT_TIMESTAMP WHERE paper_id = ?").run(reviewIssues.join("；") || null, message, paper.id);
    return NextResponse.json({ success: true, status: "needs_review", unresolved: next.ambiguous, message });
  } finally {
    db.close();
  }
}
