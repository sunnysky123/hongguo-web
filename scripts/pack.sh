#!/usr/bin/env bash
# 打包红果短剧 Web 项目为 zip。
#
# 迁移说明：后端已由 Node.js 改写为 Java，因此不再需要 Node.js 运行时，
# 目标机只要有 Java 17+ 即可（推荐 Temurin 25 LTS）。
#
#   bash scripts/pack.sh              含Windows JRE（约 74MB，开箱即用）
#   bash scripts/pack.sh --no-jre     不含 JRE（约 32MB，需目标机自备 Java 17+，推荐 25 LTS）
#   bash scripts/pack.sh --sign-only  只打签名服务与脚本
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="hongguo-web"
STAMP="$(date +%Y%m%d)"

WITH_JRE=1
ONLY_SIGN=0
for a in "$@"; do
  case "$a" in
    --no-jre)    WITH_JRE=0 ;;
    --sign-only) ONLY_SIGN=1 ;;
  esac
done

if [ "$ONLY_SIGN" = 1 ]; then
  OUT="/workspace/${NAME}-sign-${STAMP}.zip"
elif [ "$WITH_JRE" = 1 ]; then
  OUT="/workspace/${NAME}-${STAMP}.zip"
else
  OUT="/workspace/${NAME}-nojre-${STAMP}.zip"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "源目录 : $SRC"
echo "输出   : $OUT"
echo "JRE    : $([ "$WITH_JRE" = 1 ] && echo '包含' || echo '不含（需自备 Java 17+，推荐 25 LTS）')"
echo

mkdir -p "$STAGE/$NAME"

# 发行包必须开箱即用：现场构建 JAR 打入包内（用户端无需 JDK）。
# 仅签名包不含后端，跳过构建。
if [ "$ONLY_SIGN" != 1 ]; then
  echo "  构建发行 JAR（保证与源码一致）..."
  bash "$SRC/scripts/build-java.sh"
  if [ ! -f "$SRC/java/dist/hongguo-api.jar" ]; then
    echo "  [错误] 构建未产出 java/dist/hongguo-api.jar，终止打包。"
    exit 1
  fi
fi

# 复制树：排除运行时数据、编译中间产物与垃圾文件（dist 的 JAR 会打入包内）
tar -C "$SRC" -cf - \
  --exclude='./server/data' \
  --exclude='./java/build' \
  --exclude='./.git' \
  --exclude='./jre' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  . | tar -C "$STAGE/$NAME" -xf -

# 仅签名包：去掉后端与前端
if [ "$ONLY_SIGN" = 1 ]; then
  rm -rf "$STAGE/$NAME/server" "$STAGE/$NAME/web" "$STAGE/$NAME/java"
fi

# 按需带上 Windows JRE
if [ "$WITH_JRE" = 1 ] && [ -d "$SRC/jre" ]; then
  echo "  正在复制 Windows JRE（126MB，耗时稍久）..."
  cp -r "$SRC/jre" "$STAGE/$NAME/jre"
else
  mkdir -p "$STAGE/$NAME/signer"
  cat > "$STAGE/$NAME/signer/需要JRE.txt" <<'EOF'
本包未包含 Java 运行时（API 服务 JAR 已内置，无需 JDK 构建）。

全链路（API 服务 + 签名服务）都跑在 Java 上，不再需要 Node.js。
请任选一种方式：
  1) 双击 scripts\install-jre.bat 自动下载 Temurin JRE 25 到本目录
  2) 手动下载 https://adoptium.net/temurin/releases/?version=17
     解压后把 jre 文件夹放到本目录（jre\）
  3) 系统已装 Java 17+（推荐 25 LTS）亦可直接使用
EOF
  [ "$ONLY_SIGN" = 1 ] && rm -f "$STAGE/$NAME/signer/需要JRE.txt"
fi

# 重建空的运行时目录（仅签名包不含后端，不要把server/ 重新mkdir 回来）
if [ "$ONLY_SIGN" != 1 ]; then
  mkdir -p "$STAGE/$NAME/server/data/stream-cache"
  cat > "$STAGE/$NAME/server/data/.gitkeep" <<'EOF'
运行时数据目录。首次启动会自动签发 server/data/apikeys.json，
设备标识落在 server/data/device.json，
解密成品缓存在 server/data/stream-cache/。
EOF
fi

# 保留可执行位
find "$STAGE/$NAME/scripts" -name '*.sh' -exec chmod +x {} + 2>/dev/null || true

( cd "$STAGE" && zip -qr9 "$OUT" "$NAME" )

echo
echo "打包完成"
ls -lh "$OUT"
echo
echo "=== 包内顶层结构 ==="
unzip -l "$OUT" | awk '{print $4}' | grep -E "^hongguo-web/[^/]*/?$" | sort -u | sed 's/^/  /'
echo
echo "=== 校验签名资产完整性 ==="
# 优先用 unzip -Z1（只列条目名）；不可用时退回 unzip -l + awk
if unzip -Z1 "$OUT" >/dev/null 2>&1; then
  LIST="$(unzip -Z1 "$OUT")"
else
  LIST="$(unzip -l "$OUT" | awk 'NF>=4 {print $NF}')"
fi
check() {
  # 用 here-string 而非管道：避免子 shell 与缓冲导致的误判
  if grep -Fxq "hongguo-web/$1" <<<"$LIST"; then
    echo "  ✅ $1"
  else
    echo "  ❌ 缺失 $1"
  fi
}
for f in signer/unidbg-sign.jar capture/fq_oversea/libmetasec_ml.so \
         capture/fq_oversea/libc++_shared.so capture/fq_oversea/ms_16777218.bin; do
  check "$f"
done
if [ "$ONLY_SIGN" != 1 ]; then
  for f in java/src/com/hongguo/api/Main.java \
           java/dist/hongguo-api.jar \
           server/config/content-config.json \
           web/index.html web/app.js web/styles.css \
           scripts/start.bat scripts/start.sh scripts/build-java.bat; do
    check "$f"
  done
fi
if [ "$WITH_JRE" = 1 ]; then
  for f in jre/bin/java.exe jre/bin/server/jvm.dll \
           jre/lib/modules jre/release; do
    check "$f"
  done
else
  echo "  ℹ️  未包含 JRE（目标机需自备 Java 17+，推荐 25 LTS）"
fi
