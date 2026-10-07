@echo off
@chcp 65001 >nul 2>&1
@setlocal DisableDelayedExpansion
@title 停止 红果短剧 - 网页版

@cd /d "%~dp0.."

echo.
echo   正在停止相关进程...
echo.

@powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" ^
  "$targets = Get-CimInstance Win32_Process | Where-Object { " ^
  "   ($_.Name -eq 'java.exe'  -and ($_.CommandLine -like '*unidbg-sign.jar*' -or $_.CommandLine -like '*hongguo-api.jar*')) -or " ^
  "   ($_.Name -eq 'node.exe'  -and ($_.CommandLine -like '*launcher.js*' -or $_.CommandLine -like '*server\src\server.js*')) " ^
  "};" ^
  "if ($targets) { $targets | ForEach-Object { " ^
  "   Write-Host ('   [' + $_.Name.Replace('.exe','') + '] PID ' + $_.ProcessId); " ^
  "   Stop-Process -Id $_.ProcessId -Force } } " ^
  "else { Write-Host '   未发现运行中的签名/API 进程' }"

echo.
echo   [完成] 已停止。
echo.

@rem端口检测跟随 server\config\config.json，避免改了配置后仍检测旧端口
@set "PORT=8000"
@set "SIGN_PORT=9099"
@if exist "server\config\config.json" (
  @for /f "usebackq delims=" %%v in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "(Get-Content -Raw 'server\config\config.json' | ConvertFrom-Json).api.port"`) do @set "PORT=%%v"
  @for /f "usebackq delims=" %%v in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "(Get-Content -Raw 'server\config\config.json' | ConvertFrom-Json).signer.port"`) do @set "SIGN_PORT=%%v"
)

@netstat -ano | findstr /r /c:":%PORT% " /c:":%SIGN_PORT% " | findstr "LISTENING" >nul 2>&1
@if errorlevel 1 (
  echo   端口 %PORT% / %SIGN_PORT% 已释放。
) else (
  echo   [提示] 端口仍被占用，请以管理员身份重试：
  @netstat -ano | findstr LISTENING | findstr /r /c:":%PORT% " /c:":%SIGN_PORT% "
)

echo.
@pause
