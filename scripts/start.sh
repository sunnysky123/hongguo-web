#!/usr/bin/env bash
# 完整启动：签名服务 + API 服务（Linux / macOS）
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SIGN_PORT="${SIGN_PORT:-9099}"
API_PORT="${PORT:-8000}"
MODE="${1:-full}"

echo
echo "  =========================================="
echo "    红果短剧 · 网页版"
echo "  =========================================="

case "$MODE" in
  --no-sign)
    exec node scripts/launcher.js --no-sign
    ;;
  --sign-only)
    exec node scripts/launcher.js --sign-only --port "$SIGN_PORT"
    ;;
esac

command -v node >/dev/null 2>&1 || { echo "  [错误] 未找到 Node.js（需 v18+）"; exit 1; }

# shellcheck disable=SC2086
exec node scripts/launcher.js --port "$SIGN_PORT"
