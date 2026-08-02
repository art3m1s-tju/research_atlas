import { spawnSync } from "node:child_process";
import { readSyncStatus, writeSyncStatus } from "../src/lib/sync-status";

const forceSync = process.argv.includes("--force");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command: string, args: string[], phase: string, message: string, updateStatus = true) {
  if (updateStatus) writeSyncStatus({ state: "running", phase, message });
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${phase} 失败，退出码 ${result.status ?? "unknown"}`);
}

async function main() {
  try {
    run(npmCommand, ["run", "sync:full", ...(forceSync ? ["--", "--force"] : [])], "抓取论文", "正在同步论文数据源", false);
    run(npmCommand, ["run", "clean:relevance"], "清理相关性", "正在按论文和研究方向清理低相关记录");
    run(npmCommand, ["run", "embeddings:backfill"], "生成语义向量", "正在补齐新增论文的语义向量");
    run(npmCommand, ["run", "summarize:papers"], "生成中文解读", "正在补齐需要更新的中文论文解读");
    const finalStatus = readSyncStatus();
    writeSyncStatus({
      state: "completed",
      phase: "全部完成",
      message: "同步、清理、向量和中文解读均已完成",
      currentDirection: null,
      completedDirections: finalStatus.totalDirections,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    writeSyncStatus({ state: "failed", phase: "流水线失败", message: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
    process.exitCode = 1;
  }
}

main();
