#!/usr/bin/env bash
# 完整启动：签名服务 + API 服务（Linux / macOS）
#
# 迁移说明：原Node 后端已改写为 Java（java/dist/hongguo-api.jar），
# 签名服务本就是 Java，因此全链路只需一个 JRE，不再需要 Node.js。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SIGN_PORT="${SIGN_PORT:-9099}"
API_PORT="${PORT:-8000}"
MODE="${1:-full}"

echo
echo "  =========================================="
echo "    红果短剧 · 网页版"
echo "  =========================================="

# ---------- 探测 Java ----------
find_java() {
  local exe="java"
  # 项目自带 JRE：直接一层，或解压多一层（signer/jre/<目录名>/bin，Temurin zip 常见）
  if [ -x "signer/jre/bin/$exe" ]; then echo "signer/jre/bin/$exe"; return; fi
  local d
  for d in signer/jre/*/; do
    if [ -x "${d}bin/$exe" ]; then echo "${d}bin/$exe"; return; fi
  done
  [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/$exe" ] && { echo "$JAVA_HOME/bin/$exe"; return; }
  command -v java 2>/dev/null && return
  echo ""
}

JAVA_BIN="$(find_java)"
if [ -z "$JAVA_BIN" ]; then
  echo "  [错误] 未找到 Java 运行时"
  echo "         Linux/macOS：安装 Temurin 17+：https://adoptium.net/"
  echo "         或把 JRE 放到 signer/jre/ 目录下"
  exit 1
fi

# 读主版本号做闸门：签名服务依赖 JVM 内部 API，低版本会在初始化时才炸
JAVA_MAJOR="$("$JAVA_BIN" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -lt 17 ]; then
  echo "  [错误] Java 版本过低：$JAVA_MAJOR，需要 17 或更高（推荐 25 LTS）"
  exit 1
fi
echo "  [JDK] $JAVA_BIN${JAVA_MAJOR:+ (版本 $JAVA_MAJOR)}"

# ---------- 校验签名资产 ----------
JAR="java/dist/hongguo-api.jar"
if [ ! -f "signer/unidbg-sign.jar" ]; then
  echo "  [错误] 缺少 signer/unidbg-sign.jar，请确认解压时目录结构完整"
  exit 1
fi

# ---------- 确保 JAR 已构建 ----------
if [ ! -f "$JAR" ]; then
  echo "  [构建] 未找到 API 服务 JAR，正在构建..."
  bash scripts/build-java.sh
fi

case "$MODE" in
  --no-sign)
    exec "$JAVA_BIN" -jar "$JAR" --no-sign
    ;;
  --sign-only)
    exec "$JAVA_BIN" -jar "$JAR" --sign-only --port "$SIGN_PORT"
    ;;
esac

exec "$JAVA_BIN" -jar "$JAR" --port "$SIGN_PORT"
