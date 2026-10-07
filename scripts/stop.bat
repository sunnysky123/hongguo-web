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
@rem Two traps avoided here:
@rem  1) never put a multi-line for /f with backticks and a PowerShell
@rem     pipe inside an if (...) block -- cmd takes the pipe byte as the
@rem     end of the block and truncates it, leaving the ports empty.
@rem  2) never use "for /f ... do call :sub": a nested call whose "goto :eof"
@rem     returns only one level corrupts the call stack, and control falls
@rem     through to the echo lines with echo still on.
@if not defined PORT set "PORT=8000"
@if not defined SIGN_PORT set "SIGN_PORT=9099"
@set "HG_CFG_DUMP=%TEMP%\hongguo_stop_%RANDOM%.txt"
@powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $j = Get-Content -Raw 'server\config\config.json' | ConvertFrom-Json; 'PORT=' + $j.api.port; 'SIGN_PORT=' + $j.signer.port" > "%HG_CFG_DUMP%" 2>nul
@if exist "%HG_CFG_DUMP%" for /f "usebackq tokens=1,* delims==" %%A in ("%HG_CFG_DUMP%") do @set "%%A=%%B"
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
@exit /b 0
