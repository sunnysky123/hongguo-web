#!/usr/bin/env bash
# 停止签名服务与 API 服务（Linux / macOS）
set -uo pipefail

echo
echo "  正在停止相关进程..."

# 重要：排除自身（$$）与父 shell，否则 pkill -f 会匹配到本脚本的命令行而自杀。
# 模式后加 [[:space:]] 边界，避免 `server.js` 误匹配 `server.js.bak` 之类。
SELF=$$
kill_matching() {
  local pattern="$1" pid
  for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
    [ "$pid" = "$SELF" ] && continue
    [ "$pid" = "$PPID" ] && continue
    # 二次确认该进程命令行确实含目标串（pgrep -f 可能被子进程名误导）
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$2"; then
      echo "   [$3] 已停止 PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done
}

kill_matching 'unidbg-sign\.jar'    'unidbg-sign.jar'    signer
kill_matching 'scripts/launcher\.js' 'launcher.js'      launcher
kill_matching 'server/src/server\.js' 'server/src/server.js' api

sleep 1

for port in "${API_PORT:-8000}" "${SIGN_PORT:-9099}"; do
  if command -v lsof >/dev/null 2>&1 && lsof -ti tcp:"$port" >/dev/null 2>&1; then
    echo "   [提示] 端口 $port 仍被占用"
  fi
done

echo
echo "  [完成] 已停止。"
echo
