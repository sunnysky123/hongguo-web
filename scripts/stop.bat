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

@rem Port detection follows server\config\config.json, so editing the
@rem config does not leave us probing a stale port.
@rem Same trap as start.bat: never put a multi-line for /f with
@rem backticks and a PowerShell pipe inside an if (...) block -- cmd
@rem takes the pipe byte as the end of the block and truncates it,
@rem which leaves PORT/SIGN_PORT empty.
@set "PORT=8000"
@set "SIGN_PORT=9099"
@set "HG_CFG_DUMP=%TEMP%\hongguo_stop_%RANDOM%.txt"
@powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $j = Get-Content -Raw 'server\config\config.json' | ConvertFrom-Json; 'PORT=' + $j.api.port; 'SIGN_PORT=' + $j.signer.port" > "%HG_CFG_DUMP%" 2>nul
@for /f "usebackq tokens=1,* delims==" %%A in ("%HG_CFG_DUMP%") do @call :stop_cfg "%%A" "%%B"
@del /q "%HG_CFG_DUMP%" >nul 2>&1
@set "HG_CFG_DUMP="
@if not defined PORT set "PORT=8000"
@if not defined SIGN_PORT set "SIGN_PORT=9099"

@netstat -ano | findstr /r /c:":%PORT% " /c:":%SIGN_PORT% " | findstr "LISTENING" >nul 2>&1
@if errorlevel 1 (
  echo   端口 %PORT% / %SIGN_PORT% 已释放。
) else (
  echo   [提示] 端口仍被占用，请以管理员身份重试：
  @netstat -ano | findstr LISTENING | findstr /r /c:":%PORT% " /c:":%SIGN_PORT% "
)

echo.
@pause

@rem Subroutine: turn the KEY=VALUE lines printed by PowerShell into vars
:stop_cfg
@if /i "%~1"=="PORT"      set "PORT=%~2"
@if /i "%~1"=="SIGN_PORT" set "SIGN_PORT=%~2"
@goto :eof
