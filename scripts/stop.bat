@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion
title 停止 红果短剧 - 网页版

cd /d "%~dp0.."

echo.
echo   正在停止相关进程...
echo.

REM 用 PowerShell 精确匹配命令行，避免误杀其他 Java / Node 进程。
REM 注意：PowerShell 自身输出需显式设为 UTF-8，否则中文会乱码。
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" ^
  "$targets = Get-CimInstance Win32_Process | Where-Object { " ^
  "   ($_.Name -eq 'java.exe'  -and $_.CommandLine -like '*unidbg-sign.jar*') -or " ^
  "   ($_.Name -eq 'node.exe'  -and ($_.CommandLine -like '*launcher.js*' -or $_.CommandLine -like '*server\src\server.js*')) " ^
  "};" ^
  "if ($targets) { $targets | ForEach-Object { " ^
  "   Write-Host ('   [' + $_.Name.Replace('.exe','') + '] PID ' + $_.ProcessId); " ^
  "   Stop-Process -Id $_.ProcessId -Force } } " ^
  "else { Write-Host '   未发现运行中的签名/API 进程' }"

echo.
echo   [完成] 已停止。
echo.

REM ---------- 校验端口释放 ----------
netstat -ano | findstr /r /c:":8000 " /c:":9099 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  echo   端口 8000 / 9099 已释放。
) else (
  echo   [提示] 端口仍被占用，请以管理员身份重试：
  netstat -ano | findstr LISTENING | findstr /r /c:":8000 " /c:":9099 "
)

echo.
pause
