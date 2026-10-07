#!/usr/bin/env bash
# 停止签名服务与 API 服务（Linux / macOS）
set -uo pipefail

echo
echo "  正在停止相关进程..."

# 重要：排除自身（$$）与父 shell，否则 pkill -f 会匹配到本脚本的命令行而自杀。
# 模式后加 [[:space:]] 边界，避免 `hongguo-api.jar` 误匹配 `.jar.bak` 之类。
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

#迁移后API 服务与签名服务都是 Java 进程，按 jar 路径精确匹配，
# 避免误杀用户机器上其他 Java 程序。
kill_matching 'unidbg-sign\.jar'    'unidbg-sign.jar'    signer
kill_matching 'hongguo-api\.jar'    'hongguo-api.jar'    api

# 兼容旧版 Node 进程（若机器上还留着迁移前启动的服务）
kill_matching 'scripts/launcher\.js' 'launcher.js'      launcher
kill_matching 'server/src/server\.js' 'server/src/server.js' api-node

sleep 1

# 端口检测跟随 server/config/config.json
API_PORT="${PORT:-8000}"
SIGN_PORT="${SIGN_PORT:-9099}"
CFG="server/config/config.json"
if [ -f "$CFG" ]; then
  read -r A S <<<"$(python3 - "$CFG" <<'PY' 2>/dev/null || true
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
print(d.get('api',{}).get('port',8000), d.get('signer',{}).get('port',9099))
PY
)"
  [ -n "${A:-}" ] && API_PORT="${PORT:-$A}"
  [ -n "${S:-}" ] && SIGN_PORT="${SIGN_PORT:-$S}"
fi

for port in "$API_PORT" "$SIGN_PORT"; do
  if command -v lsof >/dev/null 2>&1 && lsof -ti tcp:"$port" >/dev/null 2>&1; then
    echo "   [提示] 端口 $port 仍被占用"
  fi
done

echo
echo "  [完成] 已停止。"
echo
