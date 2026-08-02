#!/bin/zsh

set -u

# Node 22+/25 can use the user's HTTPS proxy for the first model download.
export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"

ROOT_DIR="${0:A:h:h}"
cd "$ROOT_DIR"

PORT="${ATLAS_PORT:-3100}"
URL="http://localhost:${PORT}"

echo "AI Research Atlas"
echo "================="
echo "项目目录: $ROOT_DIR"
echo "访问地址: $URL"
echo

if [[ ! -d node_modules ]]; then
  echo "首次启动，正在安装依赖..."
  npm install || exit 1
fi

if [[ ! -f .env.local ]]; then
  cp .env.example .env.local
  echo "已创建本地配置文件 .env.local"
fi

save_env_secret_to_keychain() {
  local env_name="$1"
  local service_name="$2"
  local value
  value="$(awk -F= -v key="$env_name" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env.local 2>/dev/null)"
  if [[ -n "$value" ]]; then
    security add-generic-password -a "$USER" -s "$service_name" -w "$value" -U >/dev/null 2>&1 || true
  fi
}

load_keychain_secret() {
  local env_name="$1"
  local service_name="$2"
  local current_value="${(P)env_name:-}"
  if [[ -z "$current_value" ]]; then
    current_value="$(security find-generic-password -a "$USER" -s "$service_name" -w 2>/dev/null || true)"
    if [[ -n "$current_value" ]]; then
      export "$env_name=$current_value"
    fi
  fi
}

# Persist existing local keys into Keychain, then use Keychain as a fallback.
save_env_secret_to_keychain "OPENALEX_API_KEY" "ai-research-atlas.openalex"
save_env_secret_to_keychain "SEMANTIC_SCHOLAR_API_KEY" "ai-research-atlas.semantic-scholar"
load_keychain_secret "OPENALEX_API_KEY" "ai-research-atlas.openalex"
load_keychain_secret "SEMANTIC_SCHOLAR_API_KEY" "ai-research-atlas.semantic-scholar"

if curl -x '' -fsS --max-time 2 "$URL" >/dev/null 2>&1; then
  echo "服务器已经在运行，正在打开网页..."
  open "$URL"
  exit 0
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被其他程序占用。"
  echo "请关闭占用该端口的程序后重新双击此文件。"
  read -r "?按回车退出..."
  exit 1
fi

echo "正在同步最新论文..."
npm run sync:full || {
  echo "同步失败，仍尝试启动网页。"
}

echo "正在启动网页..."
npm run dev -- --port "$PORT" &
DEV_PID=$!
sleep 3
open "$URL"
wait "$DEV_PID"
