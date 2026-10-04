<#
.SYNOPSIS
    unidbg 签名服务（PowerShell 版）

.DESCRIPTION
    与 sign.bat 等价的 PowerShell 实现。
    优先使用项目自带 JRE，回退到系统 Java。

.EXAMPLE
    .\sign.ps1
    默认端口 9099

.EXAMPLE
    .\sign.ps1 -Port 9098
    指定端口
#>
[CmdletBinding()]
param(
    # 签名服务端口，默认 9099
    [int] $Port = 9099
)

$ErrorActionPreference = 'Continue'

Set-Location (Join-Path (Split-Path -Parent $PSScriptRoot) 'signer')

Write-Host ''
Write-Host '  =========================================='
Write-Host '    unidbg 签名服务'
Write-Host '  =========================================='
Write-Host ''

# ---------- 选择 Java：优先项目自带 JRE ----------
$javaBin = $null
$bundled = Join-Path $PWD 'jre\bin\java.exe'

if (Test-Path -LiteralPath $bundled) {
    $javaBin = $bundled
    Write-Host '  [JRE] 使用项目自带运行时'
}
else {
    $sysJava = Get-Command java -ErrorAction SilentlyContinue
    if (-not $sysJava) {
        Write-Host '  [错误] 未找到 Java 运行时' -ForegroundColor Red
        Write-Host ''
        Write-Host '  请任选一种方式：'
        Write-Host '    1) 把 Windows 版 JRE 解压到项目的 signer\jre\ 目录'
        Write-Host '    2) 安装 Temurin 25+ 并加入 PATH：https://adoptium.net/'
        Write-Host ''
        Write-Host '  也可运行 scripts\install-jre.bat 自动下载安装。'
        Write-Host ''
        Read-Host '  按回车键退出' | Out-Null
        exit 1
    }
    $javaBin = $sysJava.Source
    Write-Host "  [JRE] 使用系统 Java：$javaBin"
}

# ---------- 版本探测 ----------
# java -version 输出形如：openjdk version "25.0.1" 2025-10-21
# java 8 及更早为：java version "1.8.0_xxx"
$rawVersion = (& $javaBin -version 2>&1) -join "`n"
$javaMajor = 0
if ($rawVersion -match 'version\s+"(\d+)') {
    $javaMajor = [int] $Matches[1]
}
elseif ($rawVersion -match 'version\s+"1\.(\d+)') {
    $javaMajor = [int] $Matches[1]
}

if ($javaMajor -lt 17) {
    Write-Host ''
    Write-Host "  [错误] Java 版本过低：$javaMajor" -ForegroundColor Red
    Write-Host '         签名服务需要 Java 17 或更高版本，推荐 Temurin 25 LTS。'
    Write-Host '         请把 JRE 25 解压到 signer\jre\ 覆盖旧目录后重试。'
    Write-Host ''
    Read-Host '  按回车键退出' | Out-Null
    exit 1
}

# Java 24+ 需显式开启 native access（unidbg 加载 .so 的方式）
$nativeAccess = @()
if ($javaMajor -ge 24) {
    $nativeAccess = @('--enable-native-access=ALL-UNNAMED')
}

Write-Host '  [JAR] unidbg-sign.jar'
Write-Host "  [端口] $Port"
Write-Host ''
Write-Host '  启动中（unidbg 初始化约需 10-30 秒）...'
Write-Host '  停止服务：Ctrl-C 或另开窗口运行 scripts\stop.bat'
Write-Host ''

$javaArgs = @(
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED'
) + $nativeAccess + @(
    '-Xmx512m',
    '-cp', 'unidbg-sign.jar',
    'com.hongguo.sign.FqTrace', 'serve', $Port
)

& $javaBin @javaArgs

Write-Host ''
Write-Host '  签名服务已退出。'
Read-Host '  按回车键退出' | Out-Null
exit 0
