#!/usr/bin/env bash
# ============================================================
#  启动 API 服务（Linux / macOS）
#
#  设计原则与 start.bat 一致：脚本层保持极薄。
#  不解析 config.json、不判断 Java 版本、不决定任何事——
#  配置一律由 Java 侧读取 server/config/config.json。
#
#  这里只保留三件 Java 做不到的事：
#    1. 找JRE（没有 JVM 就跑不起 Java 代码）
#    2. 缺 JRE 时提示如何安装
#    3. 拉起 jar
# ============================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

JAR="java/dist/hongguo-api.jar"

# ---------- 找 JRE ----------
# 顺序与 Java 侧 Launcher.findJava 一致：自带 jre/ > JAVA_HOME > PATH。
# 自带副本优先，是为了避免系统上的旧 JDK(8/11) 抢先被选中而搞坏 unidbg。
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
  echo "  未找到 Java 运行时。"
  echo "  安装 Temurin 17+：https://adoptium.net/"
  echo "  或把 JRE 解压到项目的 jre/ 目录（需要里面有 bin/java）。"
  echo
  exit 1
fi

# ---------- jar 是否存在 ----------
# 刻意不在这里自动构建：编译需要 JDK，而本机可能只有 JRE。
# 缺失时由下面的提示说明该做什么。
if [ ! -f "$JAR" ]; then
  echo
  echo "  缺少 $PWD/$JAR"
  echo
  echo "  发行包自带预编译 jar，所以这里缺失通常是解压不完整。"
  echo "  如果你是从源码构建，请安装 JDK 17+ 后执行："
  echo "      bash scripts/build-java.sh"
  echo
  exit 1
fi

# ---------- 拉起 ----------
# 不加任何编码参数：JVM 默认已跟随控制台代码页，强行指定 UTF-8 反而会让
# 控制台按本地编码解码 UTF-8 字节而出现乱码。需要其他编码时设 HG_LOG_ENCODING。
exec "$JAVA_BIN" -jar "$JAR" "$@"
