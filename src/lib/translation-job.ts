import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * Translation job lifecycle helpers.
 *
 * Every claim gets a unique job token. All heartbeat and terminal updates
 * must be guarded by that token so a stale worker can never overwrite the
 * state of a replacement job (fencing).
 */

export type TranslationJobClaim = {
  claimed: boolean;
  jobToken: string | null;
};

const QUEUED_MESSAGE = "任务已进入队列，等待翻译进程启动";

export function claimTranslationJob(
  db: Database.Database,
  paperId: number,
  sourceHash: string,
  outputDir: string,
): TranslationJobClaim {
  const jobToken = randomUUID();
  const result = db.prepare(`
    INSERT INTO paper_translations (
      paper_id, status, source_hash, output_dir, error, attempts,
      progress_phase, progress_current, progress_total, progress_message,
      started_at, updated_at, lease_expires_at, job_token
    ) VALUES (
      ?, 'pending', ?, ?, NULL, 1,
      'queued', 0, 0, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, datetime('now', '+5 minutes'), ?
    )
    ON CONFLICT(paper_id) DO UPDATE SET
      status = 'pending',
      source_hash = excluded.source_hash,
      output_dir = excluded.output_dir,
      error = NULL,
      attempts = attempts + 1,
      progress_phase = 'queued',
      progress_current = 0,
      progress_total = 0,
      progress_message = excluded.progress_message,
      started_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP,
      lease_expires_at = datetime('now', '+5 minutes'),
      job_pid = NULL,
      job_token = excluded.job_token
    WHERE paper_translations.status NOT IN ('pending', 'running')
       OR paper_translations.lease_expires_at IS NULL
       OR paper_translations.lease_expires_at < datetime('now')
       OR paper_translations.progress_message LIKE '旧缓存已失效%'
  `).run(paperId, sourceHash, outputDir, QUEUED_MESSAGE, jobToken);
  return { claimed: result.changes > 0, jobToken: result.changes > 0 ? jobToken : null };
}

/** Where clause shared by every worker-owned update: empty token means an unmanaged manual run. */
function tokenGuard(paperId: number, jobToken: string) {
  return {
    sql: "paper_id = ? AND (? = '' OR job_token = ?)",
    args: [paperId, jobToken, jobToken],
  };
}

export function startTranslationJob(db: Database.Database, paperId: number, jobToken: string, jobPid: number, leaseMinutes: number) {
  const guard = tokenGuard(paperId, jobToken);
  return db.prepare(`UPDATE paper_translations SET status = 'running', job_pid = ?, lease_expires_at = datetime('now', ?), started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE ${guard.sql}`)
    .run(jobPid, `+${leaseMinutes} minutes`, ...guard.args);
}

export function refreshTranslationLease(db: Database.Database, paperId: number, jobToken: string, leaseMinutes: number) {
  const guard = tokenGuard(paperId, jobToken);
  return db.prepare(`UPDATE paper_translations SET lease_expires_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE ${guard.sql} AND status IN ('pending', 'running')`)
    .run(`+${leaseMinutes} minutes`, ...guard.args);
}

export function updateTranslationProgress(
  db: Database.Database,
  paperId: number,
  jobToken: string,
  leaseMinutes: number,
  phase: string,
  message: string,
  current = 0,
  total = 0,
) {
  const guard = tokenGuard(paperId, jobToken);
  return db.prepare(`UPDATE paper_translations SET status = 'running', progress_phase = ?, progress_message = ?, progress_current = ?, progress_total = ?, lease_expires_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE ${guard.sql}`)
    .run(phase, message, current, total, `+${leaseMinutes} minutes`, ...guard.args);
}

export function finishTranslationJob(
  db: Database.Database,
  paperId: number,
  jobToken: string,
  fields: { status: string; error: string | null; progressPhase: string; progressMessage: string; translatedChars?: number; progressCurrent?: number; progressTotal?: number },
) {
  const guard = tokenGuard(paperId, jobToken);
  return db.prepare(`UPDATE paper_translations SET status = ?, translated_chars = ?, error = ?, progress_phase = ?, progress_message = ?, progress_current = ?, progress_total = ?, lease_expires_at = NULL, job_pid = NULL, job_token = NULL, updated_at = CURRENT_TIMESTAMP WHERE ${guard.sql}`)
    .run(fields.status, fields.translatedChars ?? 0, fields.error, fields.progressPhase, fields.progressMessage, fields.progressCurrent ?? 0, fields.progressTotal ?? 0, ...guard.args);
}

export function failTranslationJob(db: Database.Database, paperId: number, jobToken: string, message: string) {
  const guard = tokenGuard(paperId, jobToken);
  return db.prepare(`UPDATE paper_translations SET status = 'failed', error = ?, progress_phase = 'failed', progress_message = ?, lease_expires_at = NULL, job_pid = NULL, job_token = NULL, updated_at = CURRENT_TIMESTAMP WHERE ${guard.sql} AND status IN ('pending', 'running')`)
    .run(message, message, ...guard.args);
}

/** Mark a lease-expired pending/running job as failed so the UI can offer a retry. */
export function expireStaleTranslationJob(db: Database.Database, paperId: number) {
  const message = "翻译任务已过期（worker 可能已崩溃），请重新点击翻译";
  return db.prepare("UPDATE paper_translations SET status = 'failed', error = ?, progress_phase = 'failed', progress_message = ?, lease_expires_at = NULL, job_pid = NULL, job_token = NULL, updated_at = CURRENT_TIMESTAMP WHERE paper_id = ? AND status IN ('pending', 'running') AND (lease_expires_at IS NULL OR lease_expires_at < datetime('now'))")
    .run(message, message, paperId);
}
