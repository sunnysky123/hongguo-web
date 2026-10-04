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

REM ---------- 1. 检查 Node.js（缺失时自动调用 install-node.bat） ----------
call :ensure_node
if errorlevel 1 (
  echo.
  echo   [错误] Node.js 不可用，无法继续。
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo   [1/4] Node.js !NODEV!
goto :main

REM ---------- Node.js 就绪保障 ----------
REM 用子程序而非 goto，便于 call 返回后继续执行主流程。
:ensure_node
where node >nul 2>&1
if not errorlevel 1 exit /b 0

REM HG_SKIP_NODE_INSTALL=1 时只报错不自动安装（CI / 离线环境用）
if /i "%HG_SKIP_NODE_INSTALL%"=="1" (
  echo   [错误] 未检测到 Node.js，且已设置 HG_SKIP_NODE_INSTALL=1 跳过自动安装。
  echo.
  echo   请手动安装 Node.js 18 或更高版本：https://nodejs.org/
  echo   安装时保持默认选项即可。
  exit /b 1
)

echo   [未检测到] 本机没有 Node.js。
echo.
echo   即将调用 scripts\install-node.bat 自动安装最新 LTS 版本。
echo.
REM 用 call 调用，否则控制流不会返回，后续步骤无法执行。
REM HG_ASSUME_YES=1 让安装脚本跳过重复的确认询问。
set "HG_ASSUME_YES=1"
call "%~dp0install-node.bat"
set "HG_ASSUME_YES="
if errorlevel 1 (
  echo.
  echo   [错误] Node.js 安装未完成。
  exit /b 1
)

REM 安装程序只改注册表，不会刷新当前进程的 PATH，
REM 故手动把 node.exe 所在目录追加进来，否则下面仍然检测不到。
set "NODE_DIR="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
if not defined NODE_DIR if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles(x86)%\nodejs"
if not defined NODE_DIR if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
if defined NODE_DIR (
  set "PATH=%PATH%;!NODE_DIR!"
  echo.
  echo   已刷新 PATH：!NODE_DIR!
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [错误] 安装后仍未检测到 node.exe。
  echo          请重新打开命令行窗口后重试，或手动安装：https://nodejs.org/
  exit /b 1
)
exit /b 0

:main

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

REM ---------- 5. 服务就绪后自动打开浏览器 ----------
REM launcher.js 是前台阻塞进程，没有「就绪」回调，故另起一个后台任务
REM 轮询 /health（无需密钥的免鉴权端点），就绪后再拉起浏览器。
REM HG_OPEN_BROWSER=0 可关闭该行为。
set OPEN_URL=http://127.0.0.1:!API_PORT!/
if /i "!MODE!"=="signonly" goto :no_browser
if /i "%HG_OPEN_BROWSER%"=="0" goto :no_browser
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$u='%OPEN_URL%';$h=$u+'health';for($i=0;$i -lt 180;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -Uri $h -TimeoutSec 2;if($r.StatusCode -eq 200){Start-Process $u;break}}catch{};Start-Sleep -Milliseconds 500}"
:no_browser

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
