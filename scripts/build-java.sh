#!/usr/bin/env bash
# ============================================================
#  构建红果短剧 Java API 服务
#  纯 javac + jar，无需 Maven / Gradle / 网络
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/java/src"
BUILD="$ROOT/java/build"
DIST="$ROOT/java/dist"
JAR="$DIST/hongguo-api.jar"

echo ""
echo "  ============================================"
echo "    构建 hongguo-api.jar"
echo "  ============================================"
echo ""

# ---------- 探测 JDK 17+ ----------
if ! command -v javac >/dev/null 2>&1; then
  # 优先用项目自带的 JRE（含解压多一层：jre/<目录名>/bin/javac）
  for cand in "$ROOT/jre/bin/javac" "$ROOT/jre"/*/bin/javac /usr/lib/jvm/*/bin/javac; do
    if [ -x "$cand" ]; then JAVAC="$cand"; break; fi
  done
else
  JAVAC="javac"
fi

if [ -z "${JAVAC:-}" ]; then
  echo "  [错误] 未找到 javac，本机无法编译 Java 源码。"
  echo "         说明：发行包已内置 java/dist/hongguo-api.jar，正常启动"
  echo "         不会走到这里 —— 仅在 JAR 缺失或修改源码后需要编译，"
  echo "         此时请安装 JDK 17+：https://adoptium.net/"
  exit 1
fi

VER="$("$JAVAC" -version 2>&1 | awk '{print $2}' | cut -d. -f1)"
if [ -n "$VER" ] && [ "$VER" -lt 17 ] 2>/dev/null; then
  echo "  [错误] JDK 版本过低：$VER，需要 17 或更高"
  exit 1
fi
echo "  [JDK] $("$JAVAC" -version 2>&1)"

# ---------- 编译 ----------
rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$DIST"

echo "  [1/2] 编译源码 ..."
find "$SRC" -name '*.java' > "$BUILD/sources.txt"
COUNT=$(wc -l < "$BUILD/sources.txt")
echo "        源文件 $COUNT 个"
"$JAVAC" -encoding UTF-8 -d "$BUILD/classes" @"$BUILD/sources.txt"

# ---------- 打包 ----------
echo "  [2/2] 打包 JAR ..."

# 版本号取自 server/config/config.json，与 --version 显示的保持一致。
# config.json 是版本号的唯一数据源，源码里没有副本。读不到就直接失败：
# 写一个写死的兜底号等于把版本号复制到脚本里，升级时又得改两处。
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$ROOT/server/config/config.json" 2>/dev/null | head -1)
if [ -z "$VERSION" ]; then
    echo "  [错误] server/config/config.json 里读不到 version 字段，无法确定版本号。" >&2
    echo "         请在该文件顶层补一行 \"version\": \"x.y.z\"，再重新构建。" >&2
    exit 1
fi
echo "        版本 $VERSION"
# 把资源目录（若有）一并拷入
for d in "$SRC"/../resources; do
  [ -d "$d" ] && cp -r "$d"/. "$BUILD/classes"/
done

cat > "$BUILD/manifest.txt" <<EOF
Main-Class: com.hongguo.api.Main
Implementation-Title: hongguo-api
Implementation-Version: $VERSION
EOF

rm -f "$JAR"
# jar 与 javac 同目录调用，避免 PATH 上只有 JRE 时裸 jar 找不到
JAR_BIN="$(cd "$(dirname "$JAVAC")" && pwd)"
if [ -x "$JAR_BIN/jar" ]; then
  (cd "$BUILD/classes" && "$JAR_BIN/jar" --create --file "$JAR" --manifest "$BUILD/manifest.txt" .)
else
  (cd "$BUILD/classes" && jar --create --file "$JAR" --manifest "$BUILD/manifest.txt" .)
fi

SIZE=$(du -h "$JAR" | cut -f1)
echo ""
echo "  构建完成：$JAR ($SIZE)"
echo ""
echo "  启动：java -jar $JAR"
echo ""
