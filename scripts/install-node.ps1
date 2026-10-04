<#
.SYNOPSIS
    安装 Node.js（LTS 版本）（PowerShell 版）

.DESCRIPTION
    与 install-node.bat 等价的 PowerShell 实现。
    从 nodejs.org 动态查询最新 LTS 版本号，下载 MSI 并静默安装。
    官方源失败时自动切换到 npmmirror 镜像。

.EXAMPLE
    .\install-node.ps1
    交互确认后安装

.EXAMPLE
    .\install-node.ps1 -Force
    跳过确认直接安装

.EXAMPLE
    .\install-node.ps1 -NoPause
    被其他脚本调用时不逐段暂停（由调用方控制输出节奏）
#>
[CmdletBinding()]
param(
    # 跳过交互确认，直接安装
    [switch] $Force,
    # 被调用时不显示「按回车键退出」提示
    [switch] $NoPause,
    # 最低主版本号，低于此值会提示升级
    [int] $MinMajor = 18
)

$ErrorActionPreference = 'Continue'

# 独立运行（双击/PowerShell 直接调用）时才暂停；被 start.ps1 调用时由调用方接管
if (-not $NoPause) { $script:NeedPause = $true } else { $script:NeedPause = $false }
function Wait-Enter {
    if ($script:NeedPause) { Read-Host '  按回车键退出' | Out-Null }
}

Set-Location (Split-Path -Parent $PSScriptRoot)

$UrlIndex = 'https://nodejs.org/dist/index.json'
$UrlMirror = 'https://npmmirror.com/mirrors/node'

Write-Host ''
Write-Host '  =========================================='
Write-Host '    安装 Node.js（LTS 版本）'
Write-Host '  =========================================='
Write-Host ''
Write-Host "  本项目需要 Node.js $MinMajor 或更高版本。"
Write-Host ''

# ---------- 情况 1：已安装且版本足够新 ----------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVer = (& node -v) 2>&1 | Select-Object -First 1
    Write-Host "  [检测到] 本机已安装 Node.js $nodeVer"
    Write-Host ''

    $installedMajor = [int] (($nodeVer -replace '^v', '') -split '\.')[0]
    if ($installedMajor -ge $MinMajor) {
        Write-Host "  [完成] 版本满足要求（>= $MinMajor），无需安装。"
        Write-Host ''
        Write-Host '  现在可以运行 scripts\start.bat 启动服务。'
        Write-Host ''
        Wait-Enter
        exit 0
    }
    Write-Host "  [注意] 版本低于 $MinMajor，建议升级到 LTS 版本。"
    Write-Host ''
}

# ---------- 情况 2：查询最新 LTS 版本号 ----------
Write-Host '  正在查询最新 LTS 版本...'
$ltsVer = $null
try {
    $releases = Invoke-RestMethod -Uri $UrlIndex -UseBasicParsing -TimeoutSec 30
    # index.json 按发布时间倒序：lts 字段为 false/null 的是 Current 版，需跳过
    $lts = $releases | Where-Object { $_.lts } | Select-Object -First 1
    if ($lts) { $ltsVer = $lts.version }
}
catch {
    # 网络失败时回退到调用官方安装器
    Write-Host "  [提示] 版本查询失败（$($_.Exception.Message)）" -ForegroundColor Yellow
    Write-Host '         将改用官方安装器 nodejs.org/en/download/package/installer'
    Write-Host ''
    if (-not $Force) {
        $ans = Read-Host '  是否继续？(Y/N)'
        if ($ans -notmatch '^[Yy]') {
            Write-Host '  已取消。'
            Wait-Enter
            exit 0
        }
    }
    Write-Host '  正在打开官方安装器...'
    Start-Process 'https://nodejs.org/en/download/package/installer'
    Write-Host '  安装完成后重新运行本脚本即可。'
    Write-Host ''
    Wait-Enter
    exit 0
}

if (-not $ltsVer) {
    Write-Host '  [错误] 无法获取 LTS 版本信息。' -ForegroundColor Red
    Write-Host ''
    Write-Host '  可手动打开 https://nodejs.org/zh-cn/download 下载 LTS 版本后安装。'
    Write-Host ''
    Wait-Enter
    exit 1
}

Write-Host "  最新 LTS：$ltsVer"

# ---------- 情况 3：架构检测 ----------
$arch = 'x64'
$procArch = $env:PROCESSOR_ARCHITECTURE
if ($procArch -eq 'ARM64') { $arch = 'arm64' }
if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
Write-Host "  系统架构：$procArch（使用 $arch 包）"
Write-Host ''

$fileName = "node-$ltsVer-$arch.msi"
$urlMain = "https://nodejs.org/dist/$ltsVer/$fileName"
$urlBackup = "$UrlMirror/$ltsVer/$fileName"

Write-Host "  即将下载并安装 Node.js LTS（$ltsVer，约 30-35MB）"
Write-Host '  下载地址：'
Write-Host "    $urlMain"
Write-Host ''

if (-not $Force) {
    $ans = Read-Host '  是否继续？(Y/N)'
    if ($ans -notmatch '^[Yy]') {
        Write-Host '  已取消。'
        Wait-Enter
        exit 0
    }
}

# ---------- 下载并静默安装 ----------
$msi = Join-Path $env:TEMP 'node-lts.msi'
Write-Host ''
Write-Host '  正在下载并安装，请稍候...'

$ok = $false
foreach ($u in @($urlMain, $urlBackup)) {
    try {
        Write-Host "   正在下载：$u"
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $u -OutFile $msi -UseBasicParsing -TimeoutSec 600
        if ((Get-Item $msi).Length -lt 1MB) {
            Remove-Item $msi -Force -ErrorAction SilentlyContinue
            throw '下载内容异常（文件过小）'
        }
        $ok = $true
        break
    }
    catch {
        Write-Host "   该源失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

if (-not $ok) {
    Write-Host ''
    Write-Host '  [错误] 所有下载源均失败。可手动下载后双击安装：' -ForegroundColor Red
    Write-Host "    $urlMain"
    Write-Host ''
    Wait-Enter
    exit 1
}

Write-Host '   下载完成，正在安装（静默模式）...'
try {
    $proc = Start-Process -FilePath 'msiexec.exe' `
        -ArgumentList @('/i', $msi, '/qn', '/norestart') `
        -Wait -PassThru
}
finally {
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
}

if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
    Write-Host ''
    Write-Host "  [错误] 安装程序返回码 $($proc.ExitCode)。可手动下载后双击安装：" -ForegroundColor Red
    Write-Host "    $urlMain"
    Write-Host ''
    Write-Host '  安装时请保持默认选项即可。'
    Write-Host ''
    Wait-Enter
    exit 1
}

# ---------- 安装后校验 ----------
# 新装的 node.exe 尚未进入当前进程的 PATH，需从标准安装目录查找。
$nodeExe = $null
foreach ($cand in @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)) {
    if (-not $nodeExe -and $cand -and (Test-Path -LiteralPath $cand)) {
        $nodeExe = $cand
    }
}

Write-Host ''
if (-not $nodeExe) {
    Write-Host '  [警告] 未在默认目录找到 node.exe。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  请重新打开命令行窗口以刷新 PATH，然后验证：'
    Write-Host '    node -v'
    Write-Host ''
    Write-Host '  若仍提示不是内部命令，可手动将 Node.js 安装目录'
    Write-Host '  （通常是 C:\Program Files\nodejs）加入系统 PATH。'
    Write-Host ''
    Wait-Enter
    exit 0
}

$newVer = (& $nodeExe -v) 2>&1 | Select-Object -First 1
Write-Host "  [完成] Node.js $newVer 安装成功：$nodeExe" -ForegroundColor Green
Write-Host ''
Write-Host '  现在可以运行 scripts\start.bat 启动服务。'
Write-Host ''
Wait-Enter
exit 0
