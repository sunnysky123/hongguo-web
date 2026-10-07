#!/usr/bin/env bash
# ============================================================
#  停止签名服务与 API 服务（Linux / macOS）
#
#  设计原则与 stop.bat 一致：脚本层保持极薄。
#  进程匹配、端口检查全部交给 Java 侧——它按 jar 路径匹配，
#  端口则来自 server/config/config.json，脚本不必再解析一遍。
# ============================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

JAR="java/dist/hongguo-api.jar"

find_java() {
  local exe="java" d
  [ -x "jre/bin/$exe" ] && { echo "jre/bin/$exe"; return; }
  for d in jre/*/; do
    [ -x "${d}bin/$exe" ] && { echo "${d}bin/$exe"; return; }
  done
  [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/$exe" ] && { echo "$JAVA_HOME/bin/$exe"; return; }
  command -v "$exe" 2>/dev/null && return
  echo ""
}

JAVA_BIN="$(find_java)"

if [ -z "$JAVA_BIN" ]; then
  echo
  echo "  未找到 Java 运行时，无法执行停止命令。"
  echo "  若服务仍在运行，可手动结束：pkill -f 'hongguo-api.jar'"
  echo
  exit 1
fi

if [ ! -f "$JAR" ]; then
  echo
  echo "  缺少 $PWD/$JAR"
  echo "  若服务运行在本项目的另一份拷贝里，请到那份拷贝中停止。"
  echo
  exit 1
fi

# --stop 恒返回 0：「停掉了」与「本来就没在跑」都是幂等停止的正常结局。
"$JAVA_BIN" -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar "$JAR" --stop
exit $?
