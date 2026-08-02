import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SyncCheckpoint {
  source: string;
  direction: string;
  recordsFetched: number;
  completedAt: string;
}

function checkpointPath() {
  return process.env.SYNC_CHECKPOINT_PATH || path.join(process.cwd(), "data", "sync-checkpoints.json");
}

export function readSyncCheckpoints(): SyncCheckpoint[] {
  const filePath = checkpointPath();
  if (!existsSync(filePath)) return [];
  try { return JSON.parse(readFileSync(filePath, "utf8")) as SyncCheckpoint[]; } catch { return []; }
}

export function writeSyncCheckpoint(checkpoint: SyncCheckpoint) {
  const filePath = checkpointPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const entries = readSyncCheckpoints().filter((item) => !(item.source === checkpoint.source && item.direction === checkpoint.direction));
  entries.push(checkpoint);
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(entries, null, 2));
  renameSync(temporaryPath, filePath);
}
