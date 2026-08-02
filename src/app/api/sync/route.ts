import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "fs";
import path from "path";
import { readSyncStatus } from "@/lib/sync-status";

export async function POST() {
  const current = readSyncStatus();
  if (current.state === "running") {
    return NextResponse.json({ success: true, started: false, message: "已有同步任务正在运行", status: current }, { status: 202 });
  }

  const root = process.cwd();
  const logDirectory = path.join(root, "data");
  const logPath = path.join(logDirectory, "sync.log");
  mkdirSync(logDirectory, { recursive: true });
  const logDescriptor = openSync(logPath, "a");
  const scriptPath = path.join(root, "scripts", "run-sync-pipeline.ts");
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", scriptPath, "--force"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
    env: process.env,
  });
  closeSync(logDescriptor);
  child.unref();

  return NextResponse.json({
    success: true,
    started: true,
    message: "同步已在后台开始",
    logPath,
    status: existsSync(path.join(root, "data", "sync-status.json")) ? readSyncStatus() : null,
  }, { status: 202 });
}
