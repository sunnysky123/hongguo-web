<#
.SYNOPSIS
    停止 红果短剧 · 网页版 相关进程（PowerShell 版）

.DESCRIPTION
    与 stop.bat 等价的 PowerShell 实现。
    按命令行精确匹配进程，避免误杀其他 Java / Node 进程。

.EXAMPLE
    .\stop.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host ''
Write-Host '  正在停止相关进程...'
Write-Host ''

# 精确匹配命令行，避免误杀无关进程
# Get-CimInstance 属于 CIM 模块，在部分环境下不可用（如非 Windows 主机）。
# 此时无法读取命令行，安全起见直接跳过——绝不因为「查不到」就放宽匹配条件。
$targets = @()
if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
    $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -eq 'java.exe' -and $_.CommandLine -like '*unidbg-sign.jar*') -or
            ($_.Name -eq 'node.exe' -and (
                $_.CommandLine -like '*launcher.js*' -or
                $_.CommandLine -like '*server\src\server.js*'
            ))
        }
}

if ($targets) {
    foreach ($p in $targets) {
        $label = $p.Name -replace '\.exe$', ''
        Write-Host "   [$label] PID $($p.ProcessId)"
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        }
        catch {
            Write-Host "   [$label] PID $($p.ProcessId) 停止失败：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}
else {
    Write-Host '   未发现运行中的签名/API 进程'
}

Write-Host ''
Write-Host '  [完成] 已停止。'
Write-Host ''

# ---------- 校验端口释放 ----------
# Get-NetTCPConnection 在部分环境下不可用，此时退回 netstat 解析。
$busy = @()
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    foreach ($port in @(8000, 9099)) {
        $hit = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($hit) { $busy += $port }
    }
}
else {
    $listening = netstat -ano 2>$null | Select-String 'LISTENING'
    foreach ($port in @(8000, 9099)) {
        if ($listening -and ($listening | Where-Object { $_ -match ":$port\s" })) {
            $busy += $port
        }
    }
}

if ($busy.Count -eq 0) {
    Write-Host '  端口 8000 / 9099 已释放。'
}
else {
    Write-Host "  [提示] 端口 $($busy -join ' / ') 仍被占用，请以管理员身份重试：" -ForegroundColor Yellow
    netstat -ano | Select-String 'LISTENING' | Where-Object { $_ -match ':(8000|9099)\s' } |
        ForEach-Object { Write-Host "    $($_.ToString().Trim())" }
}

Write-Host ''
Read-Host '  按回车键退出' | Out-Null
exit 0
