import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SyncState = "idle" | "running" | "completed" | "failed";

export interface SyncStatus {
  state: SyncState;
  phase: string;
  message: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  currentDirection: string | null;
  completedDirections: number;
  totalDirections: number;
  recordsFetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  errors: string[];
}

const DEFAULT_STATUS: SyncStatus = {
  state: "idle",
  phase: "等待同步",
  message: "尚未开始同步",
  startedAt: null,
  updatedAt: new Date().toISOString(),
  finishedAt: null,
  currentDirection: null,
  completedDirections: 0,
  totalDirections: 0,
  recordsFetched: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  duplicates: 0,
  errors: [],
};

export function syncStatusPath() {
  return process.env.SYNC_STATUS_PATH || path.join(process.cwd(), "data", "sync-status.json");
}

export function readSyncStatus(): SyncStatus {
  const filePath = syncStatusPath();
  if (!existsSync(filePath)) return { ...DEFAULT_STATUS, updatedAt: new Date().toISOString() };
  try {
    return { ...DEFAULT_STATUS, ...JSON.parse(readFileSync(filePath, "utf8")) } as SyncStatus;
  } catch {
    return { ...DEFAULT_STATUS, state: "failed", message: "同步状态文件无法读取", updatedAt: new Date().toISOString() };
  }
}

export function writeSyncStatus(patch: Partial<SyncStatus>) {
  const filePath = syncStatusPath();
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const status = {
    ...readSyncStatus(),
    ...patch,
    updatedAt: new Date().toISOString(),
  } as SyncStatus;
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(status, null, 2));
  renameSync(temporaryPath, filePath);
  return status;
}

export function startSyncStatus(totalDirections: number) {
  return writeSyncStatus({
    state: "running",
    phase: "准备同步",
    message: "正在连接论文数据源",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    currentDirection: null,
    completedDirections: 0,
    totalDirections,
    recordsFetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    errors: [],
  });
}
