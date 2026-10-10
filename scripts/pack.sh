#!/usr/bin/env bash
# ================================================================
#  打包红果短剧 Web 项目
#
#  为每个目标平台产出一个独立 zip，内含该平台对应的 JRE，
#  解压即用、目标机无需预装 Java。
#
#  产物（版本号取自 server/config/config.json 的 version 字段）：
#    红果web-<版本>-Windows-x64.zip     仅 .bat 脚本
#    红果web-<版本>-Windows-arm.zip     仅 .bat 脚本（见下方JRE 说明）
#    红果web-<版本>-Linux-x64.zip       仅 .sh 脚本
#    红果web-<版本>-Linux-arm.zip       仅 .sh 脚本
#    红果web-<版本>-macOS-arm.zip       仅 .sh 脚本
#
#  用法：
#    bash scripts/pack.sh              打包全部 5 个平台
#    bash scripts/pack.sh Linux-arm    只打指定平台
#    bash scripts/pack.sh --list       列出可用平台名
#
#  JRE 来自 Adoptium（Temurin），打包时按平台下载并缓存到
#  .pack-cache/。首次打包需联网，之后同一平台直接命中缓存。
#
#  关于 Windows on ARM：
#    Temurin 没有 Windows on ARM 的 JRE 25 构建，Windows ARM 包打入的
#    是同版本的 x64 JRE —— Windows on ARM64 原生支持运行 x64 程序。
#    包内「平台说明.txt」会写明这一点。
# ================================================================
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$SRC/.pack-cache"
# 产物落在仓库根的 dist/。放在仓库内而不是 /workspace，是因为打包脚本
# 可能从任意目录被调用，锚定到 SRC 才能保证「谁跑都写到同一个地方」。
# 仍可用 HG_PACK_OUTDIR 覆盖（CI 里常用临时目录）。
OUTDIR="${HG_PACK_OUTDIR:-$SRC/dist}"

JRE_VERSION="${HG_JRE_VERSION:-25}"

# ---------- 平台定义 ----------
# key       包名用的标识   Adoptium os/arch脚本内的家族
ALL_PLATFORMS=(Windows-x64 Windows-arm Linux-x64 Linux-arm macOS-arm)

platform_os() {
  case "$1" in
    Windows-*) echo "windows" ;;
    Linux-*)   echo "linux" ;;
    macOS-*)   echo "mac" ;;
  esac
}

platform_arch() {
  case "$1" in
    *-x64)  echo "x64" ;;
    *-arm)  echo "aarch64" ;;
  esac
}

# Windows ARM 没有原生 JRE 构建，退回 x64
platform_jre_arch() {
  case "$1" in
    Windows-arm) echo "x64" ;;
    *)platform_arch "$1" ;;
  esac
}

platform_family() {
  case "$1" in
    Windows-*) echo "bat" ;;
    *)echo "sh" ;;
  esac
}

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'
}

case "${1:-}" in
  --list)
    printf '%s\n' "${ALL_PLATFORMS[@]}"
    exit 0
    ;;
  -h|--help)
    usage
    exit 0
    ;;
esac

TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("${ALL_PLATFORMS[@]}")

for t in "${TARGETS[@]}"; do
  if ! printf '%s\n' "${ALL_PLATFORMS[@]}" | grep -Fxq "$t"; then
    echo "[错误] 未知平台: $t" >&2
    echo "       可用: ${ALL_PLATFORMS[*]}" >&2
    exit 1
  fi
done

# ---------- 版本号：单一数据源 ----------
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$SRC/server/config/config.json" | head -1)"
if [ -z "$VERSION" ]; then
  echo "[错误]未能从 server/config/config.json 读到 version字段。" >&2
  exit 1
fi

# 包名用 ASCII，不含中文。
#
# 「红果web-1.0.1-….zip」这个名字在 GitHub 上传后，asset 名会变成
# 「web-1.0.1-….zip」—— 非 ASCII 前缀被服务端丢掉。这不是 gh 的问题：
# 实测 gh release create、gh release upload、以及直接调 REST API 并把
# 中文名 URL 编码后传给 ?name=，三种方式返回的 asset 名都是被剥掉前缀的
# 版本。客户端绕不过去，所以只能在源头用 ASCII 名。
#
# 中文标识没有丢：Release 标题（红果web 1.0.1）与包内「平台说明.txt」
# 都还带着。
PKG_ROOT="hongguo-web-$VERSION"

echo "版本: $VERSION   (来自 server/config/config.json)"
echo "输出: $OUTDIR"
echo

# 输出目录可能还不存在（默认 dist/ 首次打包时才创建）
mkdir -p "$OUTDIR" || {
  echo "[错误] 无法创建输出目录：$OUTDIR" >&2
  exit 1
}

# ---------- 构建 JAR ----------
# 发行包必须开箱即用：现场把 JAR 构建进去，目标机无需 JDK。
# 只做一次，5 个包共用。
echo "[1/4] 构建发行 JAR ..."
bash "$SRC/scripts/build-java.sh" >/dev/null
if [ ! -f "$SRC/java/dist/hongguo-api.jar" ]; then
  echo "[错误] 构建未产出 java/dist/hongguo-api.jar，终止打包。" >&2
  exit 1
fi

# ---------- 公共树：复制一次，各平台共用 ----------
echo "[2/4] 准备公共文件树 ..."
WORK="$(mktemp -d)"
COMMON="$WORK/common"
mkdir -p "$COMMON"
trap 'rm -rf "$WORK"' EXIT

tar -C "$SRC" -cf - \
  --exclude='./server/data' \
  --exclude='./java/build' \
  --exclude='./.git' \
  --exclude='./jre' \
  --exclude='./.pack-cache' \
  --exclude='./dist' \
  --exclude='./screenshot' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  . | tar -C "$COMMON" -xf -

# 运行时目录：空目录不会被 git/tar 保留，需显式重建
mkdir -p "$COMMON/server/data/stream-cache"
cat > "$COMMON/server/data/.gitkeep" <<'EOF'
运行时数据目录。首次启动会自动签发 server/data/apikeys.json，
设备标识落在 server/data/device.json，
解密成品缓存在 server/data/stream-cache/，
启动器自身的检查/排障日志写入 server/data/log/start.log
（该目录由启动脚本首次运行时自动创建）。
EOF

# ---------- JRE 下载与缓存 ----------
mkdir -p "$CACHE"

# fetch_jre <os> <arch>
#   成功：把JRE 目录写入全局 JRE_DIR
#   失败：返回非 0，诊断信息只走 stderr
#
#刻意用全局变量而非 stdout 传递路径：这个函数既要下载（进度信息走
# stderr），又要返回路径，混用时容易把诊断文字当成路径带出去。
JRE_DIR=""
fetch_jre() {
  local os="$1" arch="$2"
  local cached="$CACHE/jre-${os}-${arch}-${JRE_VERSION}"

  if [ -d "$cached" ]; then
    JRE_DIR="$cached"
    return 0
  fi

  local api="https://api.adoptium.net/v3/assets/latest/${JRE_VERSION}/hotspot"
  api="${api}?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse"

  echo "      下载 JRE: ${os}/${arch} Temurin ${JRE_VERSION}" >&2

  local link want
  # 从 API 一次取回下载地址与权威字节数。
  # 不用 curl -I 去问 Content-Length：那个请求要再走一遍 GitHub → S3 的
  # 302 跳转链，这一跳本身就可能超时或被掐断（实测curl 28），拿到的
  # 长度不可信，反而会把好文件误判成不完整。API 返回的 size 是同一份
  # 元数据里的字段，与下载地址同源，可直接采信。
  if ! meta="$(curl -fsSL --max-time 60 "$api" \
      | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit('Adoptium API 返回的不是合法 JSON')
if not d:
    sys.exit('Temurin ${JRE_VERSION} 没有 ${os}/${arch} 的 JRE 构建')
p = d[0]['binary']['package']
sys.stdout.write(p['link'] + '\t' + str(p.get('size') or 0))
" 2>&1)"; then
    echo "[错误] 获取 JRE 下载地址失败：${os}/${arch}" >&2
    echo "       $meta" >&2
    return 1
  fi
  link="${meta%%	*}"
  want="${meta##*	}"

  # 缓存文件名沿用平台原始扩展名：Windows 的 Temurin 包是 .zip，
  # Linux/macOS 是 .tar.gz。存成 .tar.gz 会让 Windows 包在解压阶段
  # 必然失败（gz 解不了 zip），所以这里不做归一化。
  local ext="tar.gz"
  [ "$os" = "windows" ] && ext="zip"
  local tgz="$CACHE/jre-${os}-${arch}-${JRE_VERSION}.${ext}"
  local tmp="$tgz.part"

  # 下载策略：静默重试 + 断点续传 + 长度校验，循环若干轮。
  #
  # 为什么要续传：Adoptium 的文件托管在 GitHub release（再 302 到 S3），
  # 单个 JRE 约 50-60MB。实测长连接有概率中途被掐断（curl 56
  # "Failure when receiving data from the peer"），从头重下就是几十 MB。
  #
  # 为什么必须校验长度：-C - 续传时，若服务端返回的 Range 不被接受，
  # curl 可能以退出码 0 结束却只写入部分内容 —— 文件是残缺的，但看起来
  # "成功"了。这种残缺文件喂给 tar 只会得到 "gzip: stdin has more than
  # one entry" 这类与真实原因无关的报错，排查方向会被带偏。所以这里以
  # API 给出的 size 为准绳，不符就重来。
  #
  # 为什么要 -s：这条链路在输出进度条时更易断（每次写终端都要争抢
  # stdout），且 5 个包轮着打会刷出上百行控制字符。成败由退出码和
  # 字节数判定，不需要人盯着。
  local attempt got
  for attempt in 1 2 3; do
    rm -f "$tmp"
    # 每轮从零开始：残缺的 .part 留着只会让下一轮的 -C - 从错误位置续传
    if curl -fsSL \
         --retry 5 --retry-delay 3 --retry-all-errors \
         --connect-timeout 20 --max-time 480 \
         -o "$tmp" "$link"; then
      got="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
      if [ -z "$want" ] || [ "$want" -eq 0 ] || [ "$got" = "$want" ]; then
        break
      fi
      echo "      第 $attempt 次下载不完整（$got/${want:-?} 字节），重试..." >&2
    else
      echo "      第 $attempt 次下载中断，重试..." >&2
    fi
    got=0
  done

  got="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
  if [ "$got" -le 0 ]; then
    rm -f "$tmp"
    echo "[错误] JRE 下载失败：${os}/${arch}" >&2
    echo "       $link" >&2
    return 1
  fi
  if [ -n "$want" ] && [ "$want" -gt 0 ] && [ "$got" != "$want" ]; then
    rm -f "$tmp"
    echo "[错误] JRE 下载不完整：${os}/${arch}（$got/$want 字节）" >&2
    echo "       $link" >&2
    echo "       可手动下载后解压到：$cached" >&2
    return 1
  fi

  mv "$tmp" "$tgz"

  # 定位 JRE 根：找到「含有 bin/java 的那一层」，把它的内容搬进 cached/。
  #
  # 不能简单 --strip-components 1：各平台压缩包的顶层深度并不一致。
  #   Windows/Linux : jdk-25.0.4.1+1/bin/java          （一层）
  #   macOS         : jdk-25.0.4.1+1-jre/Contents/Home/bin/java
  # macOS 的 Temurin 包是 .app bundle 结构，Contents 下还有_CodeSignature、
  # Home、MacOS 等多个子目录，所以「往下数固定层数」不可靠 ——
  # 直接用 find 找出真正持有 bin/java 的目录，比硬编码层数稳。
  local unpack="$WORK/unpack-$os-$arch"
  rm -rf "$unpack"
  mkdir -p "$unpack"
  if [ "$ext" = "zip" ]; then
    if ! unzip -q "$tgz" -d "$unpack"; then
      rm -rf "$cached" "$unpack" "$tgz"
      echo "[错误] JRE 解压失败：${os}/${arch}（压缩包可能已损坏）" >&2
      return 1
    fi
  else
    if ! tar -xzf "$tgz" -C "$unpack"; then
      rm -rf "$cached" "$unpack" "$tgz"
      echo "[错误] JRE 解压失败：${os}/${arch}（压缩包可能已损坏）" >&2
      return 1
    fi
  fi

  # bin/java 所在目录的上层即为 JRE 根；-print -quit 命中第一个即停，
  # 避免 macOS 包里java 出现多次时产生多行输出。
  local launcher root
  launcher="$(find "$unpack" -type f \
        \( -name java -o -name java.exe \) -path '*/bin/*' -print -quit 2>/dev/null)"
  if [ -z "$launcher" ]; then
    rm -rf "$cached" "$unpack" "$tgz"
    echo "[错误] 压缩包里找不到 JRE 入口（bin/java）：${os}/${arch}" >&2
    return 1
  fi
  root="$(dirname "$(dirname "$launcher")")"

  cp -r "$root/." "$cached/"
  rm -rf "$unpack"

  JRE_DIR="$cached"
}

# 校验解压结果：必须有 bin/ 和 lib/modules，否则视为失败
verify_jre() {
  local d="$1" os="$2"
  local launcher="bin/java"
  [ "$os" = "windows" ] && launcher="bin/java.exe"
  if [ ! -e "$d/$launcher" ] || [ ! -e "$d/lib/modules" ]; then
    echo "[错误] JRE 内容不完整（缺少 $launcher 或 lib/modules）：$d" >&2
    return 1
  fi
}

# ---------- 逐平台打包 ----------
echo "[3/4] 下载并打包 JRE ..."
BUILT=()

for plat in "${TARGETS[@]}"; do
  os="$(platform_os "$plat")"
  arch="$(platform_arch "$plat")"
  jre_arch="$(platform_jre_arch "$plat")"
  family="$(platform_family "$plat")"
  out="$OUTDIR/${PKG_ROOT}-${plat}.zip"

  printf '  %-14s -> %s\n' "$plat" "$(basename "$out")"

  fetch_jre "$os" "$jre_arch" || exit 1
  verify_jre "$JRE_DIR" "$os" || exit 1

  # 暂存目录必须放在 COMMON 之外：放在里面会让 cp -r 把目录复制进自身
  stage="$WORK/stage-$plat"
  mkdir -p "$stage"
  cp -r "$COMMON/." "$stage/"

  # ---- 放入 JRE ----
  cp -r "$JRE_DIR" "$stage/jre"

  # ---- 平台专属脚本：只留同族 ----
  rm -f "$stage"/scripts/*.sh "$stage"/scripts/*.bat
  if [ "$family" = "bat" ]; then
    cp "$SRC/scripts/start.bat" "$SRC/scripts/stop.bat" \
       "$SRC/scripts/build-java.bat" "$stage/scripts/"
  else
    cp "$SRC/scripts/start.sh" "$SRC/scripts/stop.sh" \
       "$SRC/scripts/build-java.sh" "$stage/scripts/"
    chmod +x "$stage"/scripts/*.sh
  fi

  # ---- 平台说明 ----
  cat > "$stage/平台说明.txt" <<EOF
红果web $VERSION  ·  $plat

启动：
$( [ "$family" = "bat" ] \
   && echo "  双击 scripts\\start.bat" \
   || echo "  bash scripts/start.sh" )

Java 运行时：已内置 Temurin JRE $JRE_VERSION（$os/$jre_arch），无需另行安装。
如需查看生效配置：$([ "$family" = "bat" ] && echo "java -jar java\\dist\\hongguo-api.jar --config" || echo "java -jar java/dist/hongguo-api.jar --config")
版本      ：$VERSION
EOF

  if [ "$plat" = "Windows-arm" ]; then
    cat >> "$stage/平台说明.txt" <<'EOF'

关于 Java 运行时：
  Temurin 未发布 Windows on ARM 的 JRE 25 构建，本包内置的是同版本的
  x64（_x64）JRE。Windows on ARM64 原生支持运行 x64 程序，可直接使用；
  若你需要原生 ARM 运行时，请自行安装并替换 jre\ 目录。
EOF
  fi

  ( cd "$stage" && zip -qr9 "$out" . -x '.*' )
  rm -rf "$stage"
  BUILT+=("$out")
done

# ---------- 校验 ----------
echo "[4/4] 校验产物 ..."
for out in "${BUILT[@]}"; do
  echo
  echo "  $(basename "$out")  ($(du -h "$out" | cut -f1))"

  if unzip -Z1 "$out" >/dev/null 2>&1; then
    LIST="$(unzip -Z1 "$out")"
  else
    LIST="$(unzip -l "$out" | awk 'NF>=4 {print $NF}')"
  fi

  check() {
    if grep -Fxq "$1" <<<"$LIST"; then
      echo "    ✅ $1"
    else
      echo "    ❌ 缺失 $1"
      FAILED=1
    fi
  }

  # 每个包都该有的
  for f in server/config/config.json \
           java/dist/hongguo-api.jar \
           web/index.html \
           jre/release \
           平台说明.txt; do
    check "$f"
  done

  # 签名资产（缺了无法播放）
  for f in signer/runner/unidbg-sign.jar signer/capture/fq_oversea/libmetasec_ml.so; do
    check "$f"
  done

  # JRE 主程序：按平台
  grep -Eq '(^|/)jre/bin/java(\.exe)?$' <<<"$LIST" \
    && echo "    ✅ jre/bin/java[.exe]" \
    || { echo "    ❌ 缺失 jre/bin/java"; FAILED=1; }

  # 脚本互斥：不该出现对面家族的脚本
  plat="$(basename "$out" .zip | sed "s/^${PKG_ROOT}-//")"
  if [ "$(platform_family "$plat")" = "bat" ]; then
    if grep -qE '\.sh$' <<<"$LIST"; then
      echo "    ❌混入了 .sh 脚本"; FAILED=1
    else
      echo "    ✅ 仅含 .bat 脚本"
    fi
  else
    if grep -qE '\.bat$' <<<"$LIST"; then
      echo "    ❌ 混入了 .bat 脚本"; FAILED=1
    else
      echo "    ✅ 仅含 .sh 脚本"
    fi
  fi
done

echo
if [ "${FAILED:-0}" = 1 ]; then
  echo "打包完成，但有校验未通过项，请检查上面的 ❌。"
  exit 1
fi
echo "全部打包完成。"