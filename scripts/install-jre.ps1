<#
.SYNOPSIS
    安装 Java 运行时（签名服务依赖）（PowerShell 版）

.DESCRIPTION
    与 install-jre.bat 等价的 PowerShell 实现。
    从 Adoptium 官方源下载 Temurin JRE 25 并解压到 signer\jre\。

.EXAMPLE
    .\install-jre.ps1

.EXAMPLE
    .\install-jre.ps1 -Force
    跳过确认直接下载
#>
[CmdletBinding()]
param(
    # 跳过交互确认，直接下载
    [switch] $Force
)

$ErrorActionPreference = 'Continue'

Set-Location (Split-Path -Parent $PSScriptRoot)

$jreDir = Join-Path $PWD 'signer\jre'
$urlTemurin = 'https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jre/hotspot/normal/eclipse'

Write-Host ''
Write-Host '  =========================================='
Write-Host '    安装 Java 运行时'
Write-Host '  =========================================='
Write-Host ''
Write-Host '  签名服务需要 Java 17 或更高版本（推荐 25 LTS）。'
Write-Host ''

# ---------- 情况 1：已自带 JRE ----------
$bundledJava = Join-Path $jreDir 'bin\java.exe'
if (Test-Path -LiteralPath $bundledJava) {
    Write-Host '  [完成] 项目已自带 Java 运行时：'
    Write-Host '         signer\jre\'
    $release = Join-Path $jreDir 'release'
    if (Test-Path -LiteralPath $release) {
        $verLine = Select-String -Path $release -Pattern '^JAVA_VERSION=' -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($verLine) {
            Write-Host "         版本 $($verLine.Line -replace '^JAVA_VERSION=', '')"
        }
    }
    Write-Host ''
    Write-Host '  无需安装，可直接运行 scripts\start.bat'
    Write-Host ''
    Read-Host '  按回车键退出' | Out-Null
    exit 0
}

# ---------- 情况 2：系统已有 Java ----------
$sysJava = Get-Command java -ErrorAction SilentlyContinue
if ($sysJava) {
    Write-Host '  [检测到] 系统已安装 Java：'
    Write-Host "         $($sysJava.Source)"
    $jv = (& java -version 2>&1) -join "`n"
    if ($jv -match 'version\s+"([^"]+)"') {
        Write-Host "         版本 $($Matches[1])"
    }
    Write-Host ''
    Write-Host '  [完成] 无需安装，可直接运行 scripts\start.bat'
    Write-Host ''
    Read-Host '  按回车键退出' | Out-Null
    exit 0
}

# ---------- 情况 3：需要下载 ----------
Write-Host '  [未检测到] 本机没有 Java 运行时。'
Write-Host ''
Write-Host '  即将从 Adoptium 官方源下载 Temurin JRE 25 LTS（Windows x64，约 56MB）'
Write-Host '  下载地址：'
Write-Host "    $urlTemurin"
Write-Host ''

if (-not $Force) {
    $ans = Read-Host '  是否继续？(Y/N)'
    if ($ans -notmatch '^[Yy]') {
        Write-Host '  已取消。'
        Read-Host '  按回车键退出' | Out-Null
        exit 0
    }
}

$zip = Join-Path $env:TEMP 'temurin25-jre.zip'
$extract = Join-Path $env:TEMP 'temurin-extract'

Write-Host ''
Write-Host '  正在下载（约 56MB）...'
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $urlTemurin -OutFile $zip -UseBasicParsing -TimeoutSec 900
}
catch {
    Write-Host ''
    Write-Host "  [错误] 下载失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    Write-Host '  可手动下载后解压到 signer\jre\：'
    Write-Host '    https://adoptium.net/temurin/releases/?version=25'
    Write-Host ''
    Read-Host '  按回车键退出' | Out-Null
    exit 1
}

try {
    Write-Host '  下载完成，正在解压...'
    if (Test-Path -LiteralPath $extract) {
        Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    }
    Expand-Archive -Path $zip -DestinationPath $extract -Force

    $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
    if (-not $inner) { throw '压缩包结构异常，未找到解压目录' }

    New-Item -ItemType Directory -Force -Path $jreDir | Out-Null
    Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $jreDir -Recurse -Force
}
catch {
    Write-Host ''
    Write-Host "  [错误] 解压失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    Write-Host '  可手动下载后解压到 signer\jre\：'
    Write-Host '    https://adoptium.net/temurin/releases/?version=25'
    Write-Host ''
    Read-Host '  按回车键退出' | Out-Null
    exit 1
}
finally {
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $bundledJava) {
    Write-Host '  [完成] Java 运行时已安装到 signer\jre\' -ForegroundColor Green
}
else {
    Write-Host ''
    Write-Host '  [错误] 解压后未找到 java.exe' -ForegroundColor Red
    Write-Host ''
    Read-Host '  按回车键退出' | Out-Null
    exit 1
}

Write-Host ''
Write-Host '  现在可以运行 scripts\start.bat 启动服务。'
Write-Host ''
Read-Host '  按回车键退出' | Out-Null
exit 0
