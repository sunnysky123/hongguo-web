@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion
title 红果短剧 - 网页版

cd /d "%~dp0.."

echo.
echo   ==========================================
echo     红果短剧 · 网页版   Windows 启动器
echo   ==========================================
echo.

REM ---------- 1. 检查 Node.js ----------
where node >nul 2>&1
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js
  echo.
  echo   请安装 Node.js 18 或更高版本：https://nodejs.org/
  echo   安装时保持默认选项即可，安装后重新运行本脚本。
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo   [1/4] Node.js !NODEV!

REM ---------- 2. 检查签名资产 ----------
if not exist "signer\unidbg-sign.jar" (
  echo   [错误] 缺少 signer\unidbg-sign.jar
  echo          请确认解压时目录结构完整。
  echo.
  pause
  exit /b 1
)
if not exist "capture\fq_oversea\libmetasec_ml.so" (
  echo   [错误] 缺少 capture\fq_oversea\libmetasec_ml.so
  echo.
  pause
  exit /b 1
)
if not exist "capture\fq_oversea\libc++_shared.so" (
  echo   [错误] 缺少 capture\fq_oversea\libc++_shared.so
  echo.
  pause
  exit /b 1
)
if not exist "capture\fq_oversea\ms_16777218.bin" (
  echo   [错误] 缺少 capture\fq_oversea\ms_16777218.bin
  echo.
  pause
  exit /b 1
)
echo   [2/4] 签名资产就绪

REM ---------- 3. 选择运行模式 ----------
set MODE=full
if /i "%~1"=="--no-sign"   set MODE=nosign
if /i "%~1"=="--sign-only" set MODE=signonly

set SIGN_PORT=9099
set API_PORT=8000
if not "%SIGN_PORT_OVERRIDE%"=="" set SIGN_PORT=%SIGN_PORT_OVERRIDE%
if not "%API_PORT_OVERRIDE%"==""  set API_PORT=%API_PORT_OVERRIDE%

REM ---------- 4. 启动 ----------
echo   [3/4] 正在启动，unidbg 签名服务初始化约需 10-30 秒...
echo.

if /i "!MODE!"=="nosign" (
  echo   模式：仅 API 服务（免签接口，推荐/榜单/最新/筛选）
  echo.
  node scripts\launcher.js --no-sign
  goto :end
)

if /i "!MODE!"=="signonly" (
  echo   模式：仅签名服务
  echo.
  node scripts\launcher.js --sign-only --port !SIGN_PORT!
  goto :end
)

node scripts\launcher.js
if errorlevel 1 (
  echo.
  echo   [错误] 启动失败，请查看上方日志
  pause
  exit /b 1
)

:end
echo.
echo   服务已停止。
pause
