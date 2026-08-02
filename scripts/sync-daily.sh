#!/bin/bash

# 每日论文同步脚本
# 用法: ./sync-daily.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$PROJECT_DIR/data/sync.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始同步论文..." >> "$LOG_FILE"

cd "$PROJECT_DIR"

# 运行完整后台流水线；同步器会自动执行时间门控
npm run sync:pipeline >> "$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 同步完成" >> "$LOG_FILE"
echo "---" >> "$LOG_FILE"
