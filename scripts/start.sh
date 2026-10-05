#!/usr/bin/env bash
# 完整启动：签名服务 + API 服务（Linux / macOS）
#
# 控制台只保留 hongguo-api.jar 的输出；启动器自身的检查/排障信息
# 全部写入 server/data/log/start.log。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODE="${1:-full}"
SIGN_PORT="${SIGN_PORT:-9099}"
API_PORT="${PORT:-8000}"

LOG_DIR="server/data/log"
LOG_FILE="$LOG_DIR/start.log"
mkdir -p "$LOG_DIR"

JAR="java/dist/hongguo-api.jar"

# ---------- 启动器内部输出统一进日志 ----------
log() { echo "$@" >>"$LOG_FILE"; }

prepare() {
  log "[$(date '+%Y-%m-%d %H:%M:%S')] ===== start.sh begin ====="
  log ""
  log "  hongguo-web launcher (Unix)"

  find_java() {
    local exe="java"
    # 项目自带 JRE：直接一层，或解压多一层（jre/<目录名>/bin，Temurin zip 常见）
    if [ -x "jre/bin/$exe" ]; then echo "jre/bin/$exe"; return; fi
    local d
    for d in jre/*/; do
      if [ -x "${d}bin/$exe" ]; then echo "${d}bin/$exe"; return; fi
    done
    [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/$exe" ] && { echo "$JAVA_HOME/bin/$exe"; return; }
    command -v "$exe" 2>/dev/null && return
    echo ""
  }

  JAVA_BIN="$(find_java)"
  if [ -z "$JAVA_BIN" ]; then
    log ""
    log "  [错误] 未找到 Java 运行时"
    log "         Linux/macOS：安装 Temurin 17+：https://adoptium.net/"
    log "         或把 JRE 放到 jre/ 目录下"
    return 1
  fi

  # 读主版本号做闸门：签名服务依赖 JVM 内部 API，低版本会在初始化时才炸
  JAVA_MAJOR="$("$JAVA_BIN" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
  if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -lt 17 ]; then
    log ""
    log "  [错误] Java 版本过低：$JAVA_MAJOR，需要 17 或更高（推荐 25 LTS）"
    return 1
  fi
  log "  [JDK] $JAVA_BIN${JAVA_MAJOR:+ (版本 $JAVA_MAJOR)}"

  if [ ! -f "signer/unidbg-sign.jar" ]; then
    log ""
    log "  [错误] 缺少 signer/unidbg-sign.jar，请确认解压时目录结构完整"
    return 1
  fi
  log "  [资产] 签名资产就绪"

  if [ ! -f "$JAR" ]; then
    log "  [构建] 未找到 API 服务 JAR，正在构建..."
    bash scripts/build-java.sh >>"$LOG_FILE" 2>&1
  fi
  log "  [就绪] API 端口 $API_PORT   签名端口 $SIGN_PORT   模式 $MODE"
  return 0
}

if ! prepare; then
  echo
  echo "  [启动中止] 详见日志文件：$PWD/$LOG_FILE"
  echo
  exit 1
fi

echo
echo "  正在启动：http://127.0.0.1:${API_PORT}/"
echo "  启动器日志：$PWD/$LOG_FILE"
echo

set -- -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar "$JAR"
case "$MODE" in
  --no-sign)
    exec "$JAVA_BIN" "$@" --no-sign
    ;;
  --sign-only)
    exec "$JAVA_BIN" "$@" --sign-only --port "$SIGN_PORT"
    ;;
esac

exec "$JAVA_BIN" "$@" --port "$SIGN_PORT"