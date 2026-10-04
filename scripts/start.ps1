<#
.SYNOPSIS
    红果短剧 · 网页版   Windows 启动器（PowerShell 版）

.DESCRIPTION
    与 start.bat 等价的 PowerShell 实现，行为与输出保持一致。
    兼容 Windows PowerShell 5.1 与 PowerShell 7+。

.EXAMPLE
    .\start.ps1
    完整模式：签名服务 + API

.EXAMPLE
    .\start.ps1 -NoSign
    仅 API 服务（免签接口，无需 Java）

.EXAMPLE
    .\start.ps1 -SignOnly
    仅签名服务
#>
[CmdletBinding()]
param(
    # 仅 API 服务（免签，不启动 Java）
    [switch] $NoSign,
    # 仅签名服务
    [switch] $SignOnly,
    # 签名服务端口，默认 9099
    [int] $SignPort = 9099,
    # API 端口，默认 8000
    [int] $ApiPort = 8000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 与 bat 版一致：切到项目根目录（本文件位于 <根>/scripts/）
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# ---------- 1. 检查 Node.js（缺失时自动调用 install-node.ps1） ----------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    if ($env:HG_SKIP_NODE_INSTALL -eq '1') {
        Write-Host ''
        Write-Host '  [错误] 未检测到 Node.js，且已设置 HG_SKIP_NODE_INSTALL=1 跳过自动安装。' -ForegroundColor Red
        Write-Host ''
        Write-Host '  请手动安装 Node.js 18 或更高版本：https://nodejs.org/'
        Write-Host '  安装时保持默认选项即可。'
        Write-Host ''
        Read-Host '  按回车键退出' | Out-Null
        exit 1
    }

    Write-Host ''
    Write-Host '  [未检测到] 本机没有 Node.js。'
    Write-Host ''
    Write-Host '  即将调用 scripts\install-node.ps1 自动安装最新 LTS 版本。'
    Write-Host ''

    $installer = Join-Path $PSScriptRoot 'install-node.ps1'
    # -Force 跳过二次确认：用户已在 start 里被询问过是否继续
    & $installer -Force -NoPause
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '  [错误] Node.js 安装未完成。' -ForegroundColor Red
        Write-Host ''
        Read-Host '  按回车键退出' | Out-Null
        exit 1
    }

    # 安装程序只改注册表，不会刷新当前进程的 PATH。
    # 手动把 node.exe 所在目录追加进来，否则下面仍然取不到命令。
    foreach ($dir in @(
        (Join-Path $env:ProgramFiles 'nodejs'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
    )) {
        if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'node.exe'))) {
            if ($env:PATH -notlike "*$dir*") {
                $env:PATH = "$env:PATH;$dir"
                Write-Host "  已刷新 PATH：$dir"
            }
            break
        }
    }

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Host ''
        Write-Host '  [错误] 安装后仍未检测到 node.exe。' -ForegroundColor Red
        Write-Host '         请重新打开命令行窗口后重试，或手动安装：https://nodejs.org/'
        Write-Host ''
        Read-Host '  按回车键退出' | Out-Null
        exit 1
    }
}

$nodeVer = (& node -v) 2>&1 | Select-Object -First 1

Write-Host ''
Write-Host '  =========================================='
Write-Host '    红果短剧 · 网页版   Windows 启动器'
Write-Host '  =========================================='
Write-Host ''
Write-Host "  [1/4] Node.js $nodeVer"

# ---------- 2. 检查签名资产 ----------
$required = @(
    'signer\unidbg-sign.jar',
    'capture\fq_oversea\libmetasec_ml.so',
    'capture\fq_oversea\libc++_shared.so',
    'capture\fq_oversea\ms_16777218.bin'
)
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath $rel)) {
        Write-Host ''
        Write-Host "  [错误] 缺少 $rel" -ForegroundColor Red
        Write-Host '         请确认解压时目录结构完整。'
        Write-Host ''
        Read-Host '  按回车键退出' | Out-Null
        exit 1
    }
}
Write-Host '  [2/4] 签名资产就绪'

# ---------- 3. 运行模式 ----------
Write-Host '  [3/4] 正在启动，unidbg 签名服务初始化约需 10-30 秒...'
Write-Host ''

$launcher = Join-Path $Root 'scripts\launcher.js'

# ---------- 4. 服务就绪后自动打开浏览器 ----------
# launcher.js 是前台阻塞进程，没有「就绪」回调，故另起后台任务轮询
# /health（免鉴权端点），就绪后再拉起浏览器。
# 仅签名模式没有 API 服务，不打开；HG_OPEN_BROWSER=0 可关闭该行为。
$openUrl = "http://127.0.0.1:$ApiPort/"

if (-not $SignOnly -and $env:HG_OPEN_BROWSER -ne '0') {
    $healthUrl = $openUrl + 'health'
    # 用后台 Job 轮询，主进程继续前台跑 launcher，日志照常可见
    $null = Start-Job -Name 'OpenBrowser' -ArgumentList $openUrl, $healthUrl -ScriptBlock {
        param($u, $h)
        # 最多等 90 秒（unidbg 初始化可能较慢）
        for ($i = 0; $i -lt 180; $i++) {
            try {
                $r = Invoke-WebRequest -UseBasicParsing -Uri $h -TimeoutSec 2
                if ($r.StatusCode -eq 200) {
                    Start-Process $u
                    break
                }
            }
            catch { /* 服务未就绪，继续等 */ }
            Start-Sleep -Milliseconds 500
        }
    }
}

try {
    if ($NoSign) {
        Write-Host '  模式：仅 API 服务（免签接口，推荐/榜单/最新/筛选）'
        Write-Host ''
        & node $launcher '--no-sign'
    }
    elseif ($SignOnly) {
        Write-Host '  模式：仅签名服务'
        Write-Host ''
        & node $launcher '--sign-only' '--port' $SignPort
    }
    else {
        & node $launcher
    }
}
catch {
    Write-Host ''
    Write-Host "  [错误] 启动失败：$($_.Exception.Message)" -ForegroundColor Red
    Read-Host '  按回车键退出' | Out-Null
    exit 1
}
finally {
    # 服务已停止，确保后台轮询任务一并结束
    Get-Job -Name 'OpenBrowser' -ErrorAction SilentlyContinue |
        Stop-Job -ErrorAction SilentlyContinue
    Get-Job -Name 'OpenBrowser' -ErrorAction SilentlyContinue |
        Remove-Job -Force -ErrorAction SilentlyContinue
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '  [错误] 启动失败，请查看上方日志' -ForegroundColor Red
    Read-Host '  按回车键退出' | Out-Null
    exit 1
}

Write-Host ''
Write-Host '  服务已停止。'
Read-Host '  按回车键退出' | Out-Null
exit 0
