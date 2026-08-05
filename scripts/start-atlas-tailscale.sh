#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_BIN="$(command -v tailscale)"
elif [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
  TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
else
  echo "未找到 Tailscale，请先在 Mac 或 Ubuntu 安装并登录 Tailscale。"
  exit 1
fi

if ! "$TAILSCALE_BIN" status >/dev/null 2>&1; then
  echo "Tailscale 尚未登录，请先执行：tailscale login"
  exit 1
fi

if [[ ! -d node_modules ]]; then npm install; fi
if [[ ! -f .env.local ]]; then cp .env.example .env.local; fi

LOCAL_PORT="$(awk -F= '$1 == "ATLAS_PORT" { gsub(/[[:space:]]/, "", $2); print $2; exit }' .env.local 2>/dev/null || true)"
PORT="${ATLAS_PORT:-${LOCAL_PORT:-43117}}"
LOCAL_URL="http://127.0.0.1:${PORT}"

mkdir -p data
if ! curl -x '' -fsS --max-time 2 "$LOCAL_URL" >/dev/null 2>&1; then
  if [[ ! -f .next/BUILD_ID ]]; then npm run build; fi
  nohup npm run start -- --hostname 127.0.0.1 --port "$PORT" >"$ROOT_DIR/data/atlas-web.log" 2>&1 &
  echo $! >"$ROOT_DIR/data/atlas-web.pid"
  for _ in $(seq 1 30); do
    curl -x '' -fsS --max-time 1 "$LOCAL_URL" >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! curl -x '' -fsS --max-time 2 "$LOCAL_URL" >/dev/null 2>&1; then
  echo "Atlas 网页没有成功启动，请查看 data/atlas-web.log"
  exit 1
fi

"$TAILSCALE_BIN" serve --bg "$PORT"
echo
echo "AI Research Atlas 已通过 Tailscale 发布到你的私有 tailnet。"
echo "请在 iPhone 的 Tailscale App 中确认已登录同一账号，然后打开下面的地址："
"$TAILSCALE_BIN" serve status
