#!/usr/bin/env node
/**
 * Repository-level single-instance guard for the unified ATLAS_PORT.
 * Exits non-zero when either:
 *  - the unified port already has a listener, or
 *  - data/atlas-web.pid points to a live process whose cwd is this repo.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const root = process.cwd();
const port = Number(process.env.ATLAS_PORT || 43117);

function portOpen(targetPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: targetPort, timeout: 800 });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

if (await portOpen(port)) {
  console.error(`AI Research Atlas 已在端口 ${port} 运行，停止旧实例后再启动，避免同仓库多实例。`);
  process.exit(1);
}

const pidFile = path.join(root, "data", "atlas-web.pid");
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) {
    try {
      const cwd = execFileSync("ps", ["-o", "cwd=", "-p", String(pid)], { encoding: "utf8" }).trim();
      if (cwd === root) {
        console.error(`AI Research Atlas 已在运行（PID ${pid}），停止旧实例后再启动。`);
        process.exit(1);
      }
    } catch {
      // Stale pid file: the process is gone, so starting is safe.
    }
  }
}

process.exit(0);
