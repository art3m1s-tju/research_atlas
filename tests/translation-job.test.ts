import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureResearchFeatureSchema } from "../src/lib/research-features";
import {
  claimTranslationJob,
  expireStaleTranslationJob,
  failTranslationJob,
  finishTranslationJob,
  refreshTranslationLease,
  startTranslationJob,
} from "../src/lib/translation-job";

function freshDb() {
  const db = new Database(":memory:");
  ensureResearchFeatureSchema(db);
  return db;
}

test("first-time paper gets an atomic INSERT claim with a job token", () => {
  const db = freshDb();
  const claim = claimTranslationJob(db, 1, "hash-a", "data/translations/1");
  assert.equal(claim.claimed, true);
  assert.ok(claim.jobToken);
  const row = db.prepare("SELECT status, attempts, job_token, lease_expires_at FROM paper_translations WHERE paper_id = 1").get() as any;
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.equal(row.job_token, claim.jobToken);
  assert.ok(row.lease_expires_at);
  db.close();
});

test("an active claim cannot be double-claimed", () => {
  const db = freshDb();
  const first = claimTranslationJob(db, 1, "hash-a", "data/translations/1");
  assert.equal(first.claimed, true);
  const second = claimTranslationJob(db, 1, "hash-a", "data/translations/1");
  assert.equal(second.claimed, false);
  assert.equal(second.jobToken, null);
  db.close();
});

test("expired lease is reclaimed with a new token that fences the old worker", () => {
  const db = freshDb();
  const first = claimTranslationJob(db, 1, "hash-a", "data/translations/1");
  db.prepare("UPDATE paper_translations SET lease_expires_at = datetime('now', '-1 minute') WHERE paper_id = 1").run();
  const second = claimTranslationJob(db, 1, "hash-a", "data/translations/1");
  assert.equal(second.claimed, true);
  assert.notEqual(second.jobToken, first.jobToken);
  // A stale worker holding the old token can no longer touch the row.
  assert.equal(startTranslationJob(db, 1, first.jobToken as string, 111, 15).changes, 0);
  assert.equal(failTranslationJob(db, 1, first.jobToken as string, "stale worker").changes, 0);
  const row = db.prepare("SELECT status, job_token FROM paper_translations WHERE paper_id = 1").get() as any;
  assert.equal(row.status, "pending");
  assert.equal(row.job_token, second.jobToken);
  db.close();
});

test("worker heartbeat and terminal updates are token-guarded", () => {
  const db = freshDb();
  const claim = claimTranslationJob(db, 1, "hash-a", "data/translations/1");
  const token = claim.jobToken as string;
  startTranslationJob(db, 1, token, 42, 15);
  refreshTranslationLease(db, 1, token, 15);
  finishTranslationJob(db, 1, token, { status: "completed", error: null, progressPhase: "completed", progressMessage: "done" });
  const row = db.prepare("SELECT status, job_token, lease_expires_at FROM paper_translations WHERE paper_id = 1").get() as any;
  assert.equal(row.status, "completed");
  assert.equal(row.job_token, null);
  assert.equal(row.lease_expires_at, null);
  db.close();
});

test("expireStaleTranslationJob only touches expired pending/running rows", () => {
  const db = freshDb();
  claimTranslationJob(db, 1, "hash-a", "data/translations/1");
  assert.equal(expireStaleTranslationJob(db, 1).changes, 0);
  db.prepare("UPDATE paper_translations SET lease_expires_at = datetime('now', '-1 minute') WHERE paper_id = 1").run();
  assert.equal(expireStaleTranslationJob(db, 1).changes, 1);
  const row = db.prepare("SELECT status, error FROM paper_translations WHERE paper_id = 1").get() as any;
  assert.equal(row.status, "failed");
  assert.match(row.error, /已过期/);
  db.close();
});
