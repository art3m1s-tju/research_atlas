#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PDF2ZH_PYTHON_BIN:-$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || true)}"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "需要 Python 3.10 至 3.13；pdf2zh-next 当前不支持 Python 3.14。"
  exit 1
fi

if [[ ! -d .venv-pdf2zh ]]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python "$PYTHON_BIN" .venv-pdf2zh
  else
    "$PYTHON_BIN" -m venv .venv-pdf2zh
  fi
fi

if command -v uv >/dev/null 2>&1; then
  uv pip install --python .venv-pdf2zh/bin/python -r requirements-translation-pdf2zh.txt
else
  .venv-pdf2zh/bin/python -m pip install -r requirements-translation-pdf2zh.txt
fi

echo "pdf2zh-next 已安装。"
echo "实验模式：TRANSLATION_ENGINE=pdf2zh-next npm run translate:paper -- --paper-id <id>"
