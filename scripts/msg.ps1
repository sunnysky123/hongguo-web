# msg.ps1 -- Chinese console output for the *.bat launchers.
#
# WHY THIS EXISTS
# ---------------
# The .bat files are deliberately pure ASCII. cmd.exe reads a batch file
# with a fixed-size buffer and tracks its position by byte offset. When
# "chcp" changes the console code page in the middle of the run, that
# offset bookkeeping desynchronises: the same bytes get read twice, so
# output appears duplicated and the command echo leaks back
# ("C:\...>echo." lines). It is a cmd.exe internal, not a script bug --
# no amount of BOM / comment / offset tweaking fixes it reliably.
#
# So cmd never prints CJK. Every Chinese line is emitted from this file,
# where the code page is set explicitly and the bytes are written in one
# place. [Console]::Out.WriteLine is used rather than Write-Host so the
# output survives stdout redirection into the launcher log.
#
# USAGE from a .bat (ASCII only on the command line):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg.ps1" -Key start.banner
#
# Placeholders are read from environment variables, so the .bat side
# never has to pass non-ASCII text through the command line.

param(
  [Parameter(Position = 0)]
  [AllowEmptyString()]
  [string]$Key = ''
)

$ErrorActionPreference = 'Stop'

# UTF-8 bytes on the way out, and console CP 65001 on the way to the
# screen. When stdout is redirected to a file this also makes the log
# UTF-8, so the log and the console agree.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# ---------------------------------------------------------------- helpers

function Get-EnvOrBlank([string]$name) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($null -eq $v) { return '' }
  return $v
}

# Read a temp file into an array of lines, tolerating a missing file.
# ErrorActionPreference is 'Stop', so an unguarded ReadAllLines on a
# file the producer never wrote would abort the whole block.
function Get-LinesOrEmpty([string]$path) {
  if ([string]::IsNullOrEmpty($path)) { return @() }
  try {
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    return @([IO.File]::ReadAllLines($path))
  } catch { return @() }
}

function Get-JavaList {
  $out = @()
  try {
    $raw = & where.exe java 2>$null
    if ($raw) { $out = @($raw | Where-Object { $_ -and $_.Trim() }) }
  } catch { }
  if ($out.Count -eq 0) { $out = @('(not found on PATH)') }
  return $out
}

function Get-BundledJavaVersion([string]$jreDir) {
  $rel = Join-Path $jreDir 'release'
  try {
    if (-not (Test-Path -LiteralPath $rel)) { return '(unknown)' }
    foreach ($ln in [IO.File]::ReadAllLines($rel)) {
      if ($ln -match '^JAVA_VERSION="?([^"]+)"?') { return $Matches[1] }
    }
  } catch { }
  return '(unknown)'
}

# ----------------------------------------------------------------- blocks
# Every value is a script block that returns an array of output lines.
# Returning an array (rather than writing directly) keeps the control
# flow obvious and lets "blank" be just an empty string in the list.

$blocks = @{

  # Sets the console code page and window title, and prints nothing.
  # The .bat side calls this first, so no batch file ever has to run
  # "chcp" itself -- that is the call that desynchronises cmd's read
  # offset. The title is set from here because it is the only way to
  # get CJK into the title bar without putting CJK in the .bat.
  'init'   = {
    try { $Host.UI.RawUI.WindowTitle = '红果短剧 - 网页版' } catch { }
    return @()
  }
  'blank' = { @('') }

  # ---------------------------------------------------------- start.bat
  'start.abort' = {
    @('',
      ('  [启动中止] 详见日志文件：' + (Get-EnvOrBlank 'HG_LOG_ABS')),
      '')
  }
  'start.banner' = {
    @('',
      ('  正在启动，稍后浏览器会自动打开：' + (Get-EnvOrBlank 'OPEN_URL')),
      ('  启动器日志：' + (Get-EnvOrBlank 'HG_LOG_ABS')),
      '')
  }
  'start.exit_err' = {
    @('',
      ('  [退出] 服务异常退出（code=' + (Get-EnvOrBlank 'RC') + '），详见日志：' + (Get-EnvOrBlank 'HG_LOG_ABS')),
      '')
  }
  'start.stopped' = {
    @('',
      ('  服务已停止。启动器日志：' + (Get-EnvOrBlank 'LOG_FILE')),
      '')
  }
  'start.log_tail' = {
    @(('[' + (Get-EnvOrBlank 'HG_STAMP') + '] ===== start.bat 结束（exit=' + (Get-EnvOrBlank 'RC') + '）====='))
  }
  'start.log_head' = {
    @(('[' + (Get-EnvOrBlank 'HG_STAMP') + '] ===== start.bat begin ====='))
  }

  # ------------------------------------------------------ :prepare (log)
  'prepare.no_java'  = { @('', '  [错误] Java 运行时不可用，无法继续。') }
  'prepare.no_jar'   = { @('', '  [错误] 缺少 signer\unidbg-sign.jar', '         请确认解压时目录结构完整。') }
  'prepare.no_so'    = {
    @('',
      '  [错误] 缺少 capture\fq_oversea 下的签名 so 文件',
      '         需要：libmetasec_ml.so / libc++_shared.so / ms_16777218.bin')
  }
  'prepare.build_fail' = { @('', '  [错误] 构建失败，无法启动。') }

  'prepare.jre_src_bundled' = { @('  [JRE] 项目自带 JRE') }
  'prepare.jre_skip' = {    @('',
      '  [错误] 未检测到 Java，且配置为跳过自动安装。',
      '',
      '  请手动安装 Temurin 17 或更高版本：https://adoptium.net/',
      '  或把 JRE 解压到 jre\（要求 bin\java.exe 存在）。')
  }
  'prepare.jre_installing' = {
    @('',
      '  [未检测到] 本机没有 Java 运行时。',
      '',
      '  即将调用 scripts\install-jre.bat 自动安装 Temurin 25 LTS。',
      '')
  }
  'prepare.jre_fail' = {
    @('',
      '  [错误] Java 安装未完成。',
      '         也可以手动把 JRE 解压到 jre\（要求 bin\java.exe 存在）。')
  }
  'prepare.jre_refresh' = { @('', ('  已刷新 PATH：' + (Get-EnvOrBlank 'JAVA_DIR'))) }
  'prepare.jre_still_missing' = {
    @('',
      '  [错误] 安装后仍未检测到 java.exe。',
      '         请重新打开命令行窗口后重试，或手动安装：https://adoptium.net/')
  }
  'prepare.jre_too_old' = {
    @('',
      ('  [错误] Java 版本过低或无法识别：' + (Get-EnvOrBlank 'JAVAVER') + '（来源：' + (Get-EnvOrBlank 'JAVA_SRC') + '）'),
      '         需要 Java 17 或更高版本，推荐 Temurin 25 LTS。')
  }
  'prepare.jre_too_old_fix' = {
    $L = @('         处理：')
    if ((Get-EnvOrBlank 'JAVA_FROM_BUNDLED') -eq '1') {
      $L += '               jre 里的 JRE 版本过低或已损坏，'
      $L += '               删除 jre 后重跑 scripts\install-jre.bat，'
      $L += '               或把 Temurin 25 JRE 解压到 jre\ 覆盖（bin\java.exe 必须存在）。'
    } else {
      $L += '               重新运行 scripts\install-jre.bat 覆盖安装，'
      $L += '               或把 Temurin 25 JRE 解压到 jre\（bin\java.exe 必须存在）。'
    }
    return @($L)
  }

  # ----------------------------------------------------------- stop.bat
  'stop.header' = { @('', '  正在停止相关进程...', '') }
  'stop.done'   = { @('', '  [完成] 已停止。', '') }
  'stop.killed' = {
    $L = @()
    foreach ($ln in (Get-LinesOrEmpty (Get-EnvOrBlank 'HG_STOPPED'))) {
      if ($ln.Trim()) { $L += '   ' + $ln }
    }
    if ($L.Count -eq 0) { $L = @('   no signer/API process was running') }
    return @($L)
  }
  'stop.port_free' = {
    @(('   端口 ' + (Get-EnvOrBlank 'PORT') + ' / ' + (Get-EnvOrBlank 'SIGN_PORT') + ' 已释放。'))
  }
  'stop.port_busy' = {
    @('   [提示] 端口仍被占用，请以管理员身份重试：')
  }
  'stop.netstat' = {
    $L = @()
    foreach ($ln in (Get-LinesOrEmpty (Get-EnvOrBlank 'HG_NETSTAT'))) {
      if ($ln.Trim()) { $L += $ln }
    }
    return @($L)
  }

  # ----------------------------------------------------------- sign.bat
  'sign.banner' = {
    @('',
      '  ==========================================',
      '    unidbg 签名服务',
      '  ==========================================',
      '')
  }
  'sign.hint' = {
    @('  提示：日常使用不必单独跑本脚本。',
      '         直接双击 scripts\start.bat 会自动拉起签名服务并等待就绪。',
      '         本脚本用于单独调试签名链路，或配合 --sign-only 模式使用。',
      '')
  }
  'sign.jre_bundled' = { @('  [JRE] 使用项目自带运行时') }
  'sign.jre_system'   = { @(('  [JRE] 使用系统 Java：' + (Get-EnvOrBlank 'JAVA_BIN'))) }
  'sign.no_java' = {
    @('  [错误] 未找到 Java 运行时',
      '',
      '  请任选一种方式：',
      '     1) 把 Windows 版 JRE 解压到项目的 jre\ 目录',
      '     2) 安装 Temurin 25+ 并加入 PATH：https://adoptium.net/',
      '',
      '  也可直接双击 scripts\install-jre.bat 自动下载安装。',
      '')
  }
  'sign.run_header' = {
    @('  [JAR] unidbg-sign.jar',
      ('  [端口] ' + (Get-EnvOrBlank 'SIGN_PORT')),
      '',
      '  启动中（unidbg 初始化约需 10-30 秒）...',
      '  停止服务：Ctrl-C 或另开窗口运行 scripts\stop.bat',
      '')
  }
  'sign.jre_old' = {
    @(('  [错误] Java 版本过低：' + (Get-EnvOrBlank 'JAVA_MAJOR')),
      '         签名服务需要 Java 17 或更高版本，推荐 Temurin 25 LTS。',
      '         请把 JRE 25 解压到 jre\ 覆盖旧目录后重试。')
  }
  'sign.exited' = { @('', '  签名服务已退出。') }

  # ------------------------------------------------------ build-java.bat
  'build.no_root' = {
    @('  [错误] 定位不到项目根目录（java\src 不存在）。',
      ('         当前目录：' + (Get-EnvOrBlank 'CD')),
      '         请通过 scripts\build-java.bat 或 scripts\start.bat 运行，',
      '         不要单独复制本脚本到其他位置执行。')
  }
  'build.banner' = {
    @('',
      '  ============================================',
      '    构建 hongguo-api.jar',
      '  ============================================',
      '')
  }
  'build.jdk_bundled'      = { @('  [JDK] 项目自带 jre') }
  'build.jdk_bundled_deep' = { @('  [JDK] 项目自带 jre（解压多一层）') }
  'build.jdk_javahome'     = { @('  [JDK] JAVA_HOME') }
  'build.jdk_path'         = { @('  [JDK] 系统 PATH') }
  'build.no_jdk' = {
    @('  [错误] 未找到 javac，本机无法编译 Java 源码。',
      '         说明：发行包已内置 java\dist\hongguo-api.jar，',
      '         正常启动不会走到这里 —— 仅在 JAR 缺失（被删除或自行修改',
      '         源码）时才需要编译，此时请安装 JDK 17+：',
      '         https://adoptium.net/temurin/releases/?version=17',
      '         （下载 .msi 安装即可，默认选项会自动配置 JAVA_HOME）',
      '         或把包含 javac.exe 的完整 JDK 放入 jre\ 目录。',
      '')
  }
  'build.javac_warn' = {
    @(('  [警告] 无法读取 javac 版本（可能版本过旧或已损坏）：' + (Get-EnvOrBlank 'JAVAC_BIN')))
  }
  'build.step1'     = { @('  [1/2] 编译源码 ...') }
  'build.no_classes' = {
    @('',
      '  [错误] 无法创建 java\build\classes 目录。',
      ('         当前目录：' + (Get-EnvOrBlank 'CD')),
      '         常见原因：目录被其他程序占用（资源管理器/杀毒软件），',
      '                   或磁盘权限不足。请关闭占用后重试。',
      '')
  }
  'build.no_dist' = {
    @('  [错误] 无法创建 java\dist 目录，请检查权限后重试。', '')
  }
  'build.no_sources' = {
    @('  [错误] 未找到源文件，请确认 java\src 目录完整')
  }
  'build.cnt'     = { @(('         源文件 ' + (Get-EnvOrBlank 'CNT') + ' 个')) }
  'build.compile_fail' = { @('', '  [错误] 编译失败，请查看上方报错') }
  'build.step2'   = { @('  [2/2] 打包 JAR ...') }
  'build.pushd_fail' = {
    @('',
      '  [错误] 无法进入 java\build\classes（系统找不到指定的路径）。',
      ('         当前目录：' + (Get-EnvOrBlank 'CD')),
      '         请关闭占用该目录的程序后重试。',
      '')
  }
  'build.jar_fail' = {
    @('',
      ('  [错误] 打包失败（jar 退出码 ' + (Get-EnvOrBlank 'RC') + '）。'),
      ('         使用的 JDK bin：' + (Get-EnvOrBlank 'JDK_BIN')),
      '         请确认该目录下 jar.exe 存在且为 JDK 9+。')
  }
  'build.done' = {
    @('',
      ('  构建完成：java\dist\hongguo-api.jar (' + (Get-EnvOrBlank 'SIZE_KB') + ' KB)'),
      '',
      '  启动：scripts\start.bat',
      '')
  }

  # ----------------------------------------------------- install-jre.bat
  'jre.banner' = {
    @('',
      '  ==========================================',
      '    安装 Java 运行时',
      '  ==========================================',
      '',
      '  签名服务需要 Java 17 或更高版本（推荐 25 LTS）。',
      '')
  }
  'jre.have_bundled' = {
    $L = @('  [完成] 项目已自带 Java 运行时：',
           '         jre\',
           ('         版本 ' + (Get-BundledJavaVersion (Get-EnvOrBlank 'JRE_DIR'))))
    $L += ''
    $L += '  无需安装，可直接运行 scripts\start.bat'
    $L += ''
    return @($L)
  }
  'jre.have_system' = {
    $L = @('  [检测到] 系统已安装 Java：')
    foreach ($p in (Get-JavaList)) { $L += '         ' + $p }
    try {
      $ver = & java -version 2>&1 | Where-Object { $_ -match 'version' }
      foreach ($ln in $ver) { $L += '         ' + $ln.ToString().Trim() }
    } catch { }
    $L += ''
    $L += '  [完成] 无需安装，可直接运行 scripts\start.bat'
    $L += ''
    return @($L)
  }
  'jre.need_download' = {
    @('  [未检测到] 本机没有 Java 运行时。',
      '',
      '  即将从 Adoptium 官方源下载 Temurin JRE 25 LTS（Windows x64，约 56MB）',
      '  下载地址：',
      ('    ' + (Get-EnvOrBlank 'URL_TEMURIN')),
      '')
  }
  'jre.prompt'   = { @('   是否继续？(Y/N) ') }
  'jre.cancelled' = { @('   已取消。') }
  'jre.downloading' = { @('', '   正在下载...') }
  'jre.extracting'  = { @('   下载完成，正在解压...') }
  'jre.ok'      = { @('   [完成] Java 运行时已安装到 jre\') }
  'jre.unpack_fail' = { @('   [错误] 解压后未找到 java.exe') }
  'jre.fail' = {
    @('',
      '  安装失败。可手动下载后解压到 jre\：',
      '    https://adoptium.net/temurin/releases/?version=25',
      '')
  }
  'jre.done' = { @('  现在可以运行 scripts\start.bat 启动服务。', '') }
}

# ---------------------------------------------------------------- output
#
# An empty key is tolerated and exits 0 silently. It happens when a
# "call :say <key>" sits inside an if (...) block: cmd parses the block
# as one compound command and the subroutine argument is lost, so %~1
# arrives here empty. The .bat side no longer relies on call inside a
# block, but failing quietly beats aborting the launcher outright.

if ([string]::IsNullOrWhiteSpace($Key)) { exit 0 }

$out = [Console]::Out
foreach ($k in ($Key -split ',')) {
  $k = $k.Trim()
  if ($k -eq '') { continue }
  if (-not $blocks.ContainsKey($k)) {
    [Console]::Error.WriteLine("msg.ps1: unknown key '$k'")
    exit 2
  }
  foreach ($ln in @(& $blocks[$k])) {
    if ($null -eq $ln) { $out.WriteLine('') }
    else { $out.WriteLine([string]$ln) }
  }
}
$out.Flush()
exit 0
