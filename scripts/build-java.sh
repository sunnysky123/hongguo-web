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
  # 优先用项目自带的 JRE（含解压多一层：signer/jre/<目录名>/bin/javac）
  for cand in "$ROOT/signer/jre/bin/javac" "$ROOT/signer/jre"/*/bin/javac /usr/lib/jvm/*/bin/javac; do
    if [ -x "$cand" ]; then JAVAC="$cand"; break; fi
  done
else
  JAVAC="javac"
fi

if [ -z "${JAVAC:-}" ]; then
  echo "  [错误] 未找到 javac，请安装 JDK 17 或更高版本"
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
# 把资源目录（若有）一并拷入
for d in "$SRC"/../resources; do
  [ -d "$d" ] && cp -r "$d"/. "$BUILD/classes"/
done

cat > "$BUILD/manifest.txt" <<EOF
Main-Class: com.hongguo.api.Main
Implementation-Title: hongguo-api
Implementation-Version: 1.0.0
EOF

rm -f "$JAR"
(cd "$BUILD/classes" && jar --create --file "$JAR" --manifest "$BUILD/manifest.txt" .)

SIZE=$(du -h "$JAR" | cut -f1)
echo ""
echo "  构建完成：$JAR ($SIZE)"
echo ""
echo "  启动：java -jar $JAR"
echo ""
