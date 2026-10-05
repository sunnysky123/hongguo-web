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

REM ============================================================
REM  全链路只需 Java，不再需要 Node.js。
REM  迁移说明：原Node 后端已改写为 Java（java/dist/hongguo-api.jar），
REM  签名服务本就是 Java，两者现在由同一个启动器编排。
REM ============================================================

REM ---------- 1. 检查 Java 运行时 ----------
call :ensure_java
if errorlevel 1 (
  echo.
  echo   [错误] Java 运行时不可用，无法继续。
  echo.
  pause
  exit /b 1
)
echo   [1/4] Java !JAVAVER!（!JAVA_SRC!）

REM ---------- 2. 检查签名资产 ----------
if not exist "signer\unidbg-sign.jar" (
  echo   [错误] 缺少 signer\unidbg-sign.jar
  echo          请确认解压时目录结构完整。
  echo.
  pause
  exit /b 1
)
if not exist "capture\fq_oversea\libmetasec_ml.so"    goto :missing_so
if not exist "capture\fq_oversea\libc++_shared.so"    goto :missing_so
if not exist "capture\fq_oversea\ms_16777218.bin"      goto :missing_so
echo   [2/4] 签名资产就绪
goto :after_so

:missing_so
echo   [错误] 缺少 capture\fq_oversea 下的签名 so 文件
echo          需要：libmetasec_ml.so / libc++_shared.so / ms_16777218.bin
echo.
pause
exit /b 1

:after_so

REM ---------- 3. 确保 JAR 已构建 ----------
if not exist "java\dist\hongguo-api.jar" (
  echo   [3/4] 未找到 API 服务 JAR，正在构建...
  call "%~dp0build-java.bat"
  if errorlevel 1 (
    echo.
    echo   [错误] 构建失败，无法启动。
    pause
    exit /b 1
  )
) else (
  echo   [3/4] API 服务 JAR 就绪
)

REM ---------- 4. 端口与运行模式 ----------
set SIGN_PORT=9099
set API_PORT=8000
if not "%SIGN_PORT_OVERRIDE%"=="" set SIGN_PORT=%SIGN_PORT_OVERRIDE%
if not "%API_PORT_OVERRIDE%"==""  set API_PORT=%API_PORT_OVERRIDE%

set MODE=full
if /i "%~1"=="--no-sign"   set MODE=nosign
if /i "%~1"=="--sign-only" set MODE=signonly

REM ---------- 5. 服务就绪后自动打开浏览器 ----------
REM 启动器是前台阻塞进程，没有「就绪」回调，故另起一个后台任务
REM 轮询 /health（无需密钥的免鉴权端点），就绪后再拉起浏览器。
REM HG_OPEN_BROWSER=0 可关闭该行为。
set OPEN_URL=http://127.0.0.1:!API_PORT!/
if /i "!MODE!"=="signonly" goto :no_browser
if /i "%HG_OPEN_BROWSER%"=="0" goto :no_browser
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$u='%OPEN_URL%';$h=$u+'health';for($i=0;$i -lt 240;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -Uri $h -TimeoutSec 2;if($r.StatusCode -eq 200){Start-Process $u;break}}catch{};Start-Sleep -Milliseconds 500}"
:no_browser

REM ---------- 6. 启动 ----------
echo   [4/4] 正在启动（unidbg 签名服务初始化约需 10-30 秒）...
echo.

if /i "!MODE!"=="nosign" (
  echo   模式：仅 API 服务（免签接口，推荐/榜单/最新/筛选）
  echo.
  set "PORT=!API_PORT!"
  java -jar java\dist\hongguo-api.jar --no-sign
  goto :end
)

if /i "!MODE!"=="signonly" (
  echo   模式：仅签名服务
  echo.
  set "SIGN_PORT=!SIGN_PORT!"
  java -jar java\dist\hongguo-api.jar --sign-only
  goto :end
)

java -jar java\dist\hongguo-api.jar --port !SIGN_PORT!
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
exit /b 0

REM ============================================================
REM  Java 就绪保障
REM  用子程序而非 goto，便于 call 返回后继续执行主流程。
REM ============================================================
:ensure_java
REM ---------- 探测优先级：项目自带 JRE > JAVA_HOME > 系统 PATH > 自动安装 ----------
REM 与 Launcher.findJava() 保持一致：自带 JRE 最优先，避免系统 PATH 上
REM 的旧 JDK（如 8/11）抢先被选中，导致 unidbg 在旧 JRE 上异常。
REM 兼容两种放置：jre\bin\java.exe，以及 Temurin zip 解压多一层
REM （jre\jdk-25.x\bin\java.exe）。
set "BUNDLED_BIN="
if exist "jre\bin\java.exe" set "BUNDLED_BIN=%CD%\jre\bin"
if not defined BUNDLED_BIN for /d %%d in ("jre\*") do (
  if not defined BUNDLED_BIN if exist "%%~fd\bin\java.exe" set "BUNDLED_BIN=%%~fd\bin"
)
if defined BUNDLED_BIN (
  set "PATH=!BUNDLED_BIN!;%PATH%"
  set "JAVA_SRC=项目自带 JRE"
  set "JAVA_FROM_BUNDLED=1"
  goto :found_java
)

if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" (
  set "PATH=%JAVA_HOME%\bin;!PATH!"
  set "JAVA_SRC=JAVA_HOME"
  goto :found_java
)

where java >nul 2>&1
if not errorlevel 1 (
  set "JAVA_SRC=系统 PATH"
  goto :found_java
)

REM HG_SKIP_JRE_INSTALL=1 时只报错不自动安装（CI / 离线环境用）
if /i "%HG_SKIP_JRE_INSTALL%"=="1" (
  echo   [错误] 未检测到 Java，且已设置 HG_SKIP_JRE_INSTALL=1 跳过自动安装。
  echo.
  echo   请手动安装 Temurin 17 或更高版本：https://adoptium.net/
  echo   或把 JRE 解压到 jre\（要求 bin\java.exe 存在）。
  exit /b 1
)

echo   [未检测到] 本机没有 Java 运行时。
echo.
echo   即将调用 scripts\install-jre.bat 自动安装 Temurin 25 LTS。
echo.
REM 用 call 调用，否则控制流不会返回，后续步骤无法执行。
REM HG_ASSUME_YES=1 让安装脚本跳过重复的确认询问。
set "HG_ASSUME_YES=1"
call "%~dp0install-jre.bat"
set "HG_ASSUME_YES="
if errorlevel 1 (
  echo.
  echo   [错误] Java 安装未完成。
  echo          也可以手动把 JRE 解压到 jre\（要求 bin\java.exe 存在）。
  exit /b 1
)

REM 安装程序不会刷新当前进程的 PATH，
REM 故手动把 java.exe 所在目录前置进来，否则下面仍然检测不到。
set "JAVA_DIR="
if exist "%ProgramFiles%\Eclipse Adoptium\jdk-25\bin\java.exe" set "JAVA_DIR=%ProgramFiles%\Eclipse Adoptium\jdk-25"
if not defined JAVA_DIR if exist "%ProgramFiles%\Java\jdk-25\bin\java.exe" set "JAVA_DIR=%ProgramFiles%\Java\jdk-25"
if not defined JAVA_DIR if exist "%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-25\bin\java.exe" set "JAVA_DIR=%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-25"
if defined JAVA_DIR (
  set "PATH=!JAVA_DIR!\bin;%PATH%"
  set "JAVA_SRC=安装目录"
  echo.
  echo   已刷新 PATH：!JAVA_DIR!\bin
)

where java >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [错误] 安装后仍未检测到 java.exe。
  echo          请重新打开命令行窗口后重试，或手动安装：https://adoptium.net/
  exit /b 1
)

:found_java
REM 读主版本号（java -version 的输出走 stderr）
set JAVAVER=unknown
for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /r "version ""[0-9]"') do (
  set "JAVAVER=%%~v"
  set "JAVAVER=!JAVAVER:v=!"
)

REM 版本闸门：签名服务依赖 JVM 内部 API，低版本会在初始化时才炸，
REM 这里提前拦下并说清原因，免得用户只看到「签名服务未就绪」。
set JAVA_MAJOR=0
for /f "tokens=1 delims=." %%m in ("!JAVAVER!") do set "JAVA_MAJOR=%%m"
if !JAVA_MAJOR! LSS 17 (
  echo   [错误] Java 版本过低或无法识别：!JAVAVER!（来源：!JAVA_SRC!）
  echo          需要 Java 17 或更高版本，推荐 Temurin 25 LTS。
  if defined JAVA_FROM_BUNDLED (
    echo          处理：jre 里的 JRE 版本过低或已损坏，
    echo                删除 jre 后重跑 scripts\install-jre.bat，
    echo                或把 Temurin 25 JRE 解压到 jre\ 覆盖（bin\java.exe 必须存在）。
  ) else (
    echo          处理：重新运行 scripts\install-jre.bat 覆盖安装，
    echo                或把 Temurin 25 JRE 解压到 jre\（bin\java.exe 必须存在）。
  )
  echo.
  pause
  exit /b 1
)
exit /b 0
