#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${TRANSLATION_PYTHON_BIN:-$(command -v python3.14 || command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3 || true)}"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "需要 Python 3.10 或更高版本。"
  exit 1
fi

if [[ ! -d .venv-atlas-parser ]]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python "$PYTHON_BIN" .venv-atlas-parser
  else
    "$PYTHON_BIN" -m venv .venv-atlas-parser
  fi
fi

if command -v uv >/dev/null 2>&1; then
  uv pip install --python .venv-atlas-parser/bin/python -r requirements-translation.txt
else
  .venv-atlas-parser/bin/python -m pip install -r requirements-translation.txt
fi

echo "Docling 解析器已安装。"
echo "后续翻译任务会自动优先提取公式、图片、表格和阅读顺序。"
