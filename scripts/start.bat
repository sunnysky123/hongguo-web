@echo off
@chcp 65001 >nul 2>&1
@setlocal DisableDelayedExpansion
@title 红果短剧 - 网页版

@cd /d "%~dp0.."

@set "SCRIPT_ARG=%~1"
@if not exist "server\data\log" mkdir "server\data\log"
@set "LOG_FILE=server\data\log\start.log"

@call :prepare 1>>"%LOG_FILE%" 2>&1
@if errorlevel 1 (
  echo.
  echo   [启动中止] 详见日志文件：%CD%\%LOG_FILE%
  echo.
@ pause
@ exit /b 1
)

echo.
echo   正在启动，稍后浏览器会自动打开：http://127.0.0.1:%API_PORT%/
echo   启动器日志：%CD%\%LOG_FILE%
echo.

@if /i "%MODE%"=="nosign"   set "PORT=%API_PORT%"
@if /i "%MODE%"=="signonly" set "SIGN_PORT=%SIGN_PORT%"

@java -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar java\dist\hongguo-api.jar --port %SIGN_PORT%
@set "RC=%ERRORLEVEL%"
@>>"%LOG_FILE%" echo [%DATE% %TIME%] ===== start.bat 结束（exit=%RC%）=====
@if not "%RC%"=="0" (
  echo.
  echo   [退出] 服务异常退出（code=%RC%），详见日志：%CD%\%LOG_FILE%
  echo.
@ pause
@ exit /b %RC%
)
echo.
echo   服务已停止。启动器日志：%LOG_FILE%
@pause
@exit /b 0

:prepare
echo [%DATE% %TIME%] ===== start.bat begin =====
echo.
echo   hongguo-web launcher (Windows)

@call :ensure_java
@if errorlevel 1 (
  echo.
  echo   [错误] Java 运行时不可用，无法继续。
@ exit /b 1
)
echo   [1/4] Java %JAVAVER%（%JAVA_SRC%）

@if not exist "signer\unidbg-sign.jar" (
  echo.
  echo   [错误] 缺少 signer\unidbg-sign.jar
  echo          请确认解压时目录结构完整。
@ exit /b 1
)
@if not exist "capture\fq_oversea\libmetasec_ml.so"    goto :missing_so
@if not exist "capture\fq_oversea\libc++_shared.so"    goto :missing_so
@if not exist "capture\fq_oversea\ms_16777218.bin"      goto :missing_so
echo   [2/4] 签名资产就绪
@goto :after_so

:missing_so
echo.
echo   [错误] 缺少 capture\fq_oversea 下的签名 so 文件
echo          需要：libmetasec_ml.so / libc++_shared.so / ms_16777218.bin
@exit /b 1

:after_so
@if not exist "java\dist\hongguo-api.jar" (
  echo   [3/4] 未找到 API 服务 JAR，正在构建...
@ call "%~dp0build-java.bat"
@ if errorlevel 1 (
    echo.
    echo   [错误] 构建失败，无法启动。
@   exit /b 1
  )
) else (
  echo   [3/4] API 服务 JAR 就绪
)

@set SIGN_PORT=9099
@set API_PORT=8000
@if not "%SIGN_PORT_OVERRIDE%"=="" set SIGN_PORT=%SIGN_PORT_OVERRIDE%
@if not "%API_PORT_OVERRIDE%"==""  set API_PORT=%API_PORT_OVERRIDE%

@set MODE=full
@if /i "%SCRIPT_ARG%"=="--no-sign"   set MODE=nosign
@if /i "%SCRIPT_ARG%"=="--sign-only" set MODE=signonly

@set OPEN_URL=http://127.0.0.1:%API_PORT%/
@if /i "%MODE%"=="signonly" goto :no_browser
@if /i "%HG_OPEN_BROWSER%"=="0" goto :no_browser
@start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$u='%OPEN_URL%';$h=$u+'health';for($i=0;$i -lt 240;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -Uri $h -TimeoutSec 2;if($r.StatusCode -eq 200){Start-Process $u;break}}catch{};Start-Sleep -Milliseconds 500}"
:no_browser

echo   [4/4] 启动参数就绪，交由 hongguo-api.jar 运行
echo   API 端口 %API_PORT%   签名端口 %SIGN_PORT%   模式 %MODE%
@exit /b 0

:ensure_java
@set "BUNDLED_BIN="
@if exist "jre\bin\java.exe" set "BUNDLED_BIN=%CD%\jre\bin"
@if not defined BUNDLED_BIN for /d %%d in ("jre\*") do (
@ if not defined BUNDLED_BIN if exist "%%~fd\bin\java.exe" set "BUNDLED_BIN=%%~fd\bin"
)
@if defined BUNDLED_BIN (
  @set "PATH=%BUNDLED_BIN%;%PATH%"
  @set "JAVA_SRC=项目自带 JRE"
  @set "JAVA_FROM_BUNDLED=1"
  @goto :found_java
)

@if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" (
  @set "PATH=%JAVA_HOME%\bin;%PATH%"
  @set "JAVA_SRC=JAVA_HOME"
  @goto :found_java
)

@where java >nul 2>&1
@if not errorlevel 1 (
  @set "JAVA_SRC=系统 PATH"
  @goto :found_java
)

@if /i "%HG_SKIP_JRE_INSTALL%"=="1" (
  echo.
  echo   [错误] 未检测到 Java，且已设置 HG_SKIP_JRE_INSTALL=1 跳过自动安装。
  echo.
  echo   请手动安装 Temurin 17 或更高版本：https://adoptium.net/
  echo   或把 JRE 解压到 jre\（要求 bin\java.exe 存在）。
@ exit /b 1
)

echo   [未检测到] 本机没有 Java 运行时。
echo.
echo   即将调用 scripts\install-jre.bat 自动安装 Temurin 25 LTS。
echo.
@set "HG_ASSUME_YES=1"
@call "%~dp0install-jre.bat"
@set "HG_ASSUME_YES="
@if errorlevel 1 (
  echo.
  echo   [错误] Java 安装未完成。
  echo          也可以手动把 JRE 解压到 jre\（要求 bin\java.exe 存在）。
@ exit /b 1
)

@set "JAVA_DIR="
@if exist "%ProgramFiles%\Eclipse Adoptium\jdk-25\bin\java.exe" set "JAVA_DIR=%ProgramFiles%\Eclipse Adoptium\jdk-25"
@if not defined JAVA_DIR if exist "%ProgramFiles%\Java\jdk-25\bin\java.exe" set "JAVA_DIR=%ProgramFiles%\Java\jdk-25"
@if not defined JAVA_DIR if exist "%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-25\bin\java.exe" set "JAVA_DIR=%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-25"
@if defined JAVA_DIR (
  @set "PATH=%JAVA_DIR%\bin;%PATH%"
  @set "JAVA_SRC=安装目录"
  echo.
  echo   已刷新 PATH：%JAVA_DIR%\bin
)

@where java >nul 2>&1
@if errorlevel 1 (
  echo.
  echo   [错误] 安装后仍未检测到 java.exe。
  echo          请重新打开命令行窗口后重试，或手动安装：https://adoptium.net/
@ exit /b 1
)

:found_java
@set JAVAVER=unknown
@for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /r "version ""[0-9]"') do @set "JAVAVER=%%~v"
@set "JAVAVER=%JAVAVER:v=%"

@set JAVA_MAJOR=0
@for /f "tokens=1 delims=." %%m in ("%JAVAVER%") do set "JAVA_MAJOR=%%m"
@if %JAVA_MAJOR% LSS 17 (
  echo.
  echo   [错误] Java 版本过低或无法识别：%JAVAVER%（来源：%JAVA_SRC%）
  echo          需要 Java 17 或更高版本，推荐 Temurin 25 LTS。
@ if defined JAVA_FROM_BUNDLED (
    echo          处理：jre 里的 JRE 版本过低或已损坏，
    echo                删除 jre 后重跑 scripts\install-jre.bat，
    echo                或把 Temurin 25 JRE 解压到 jre\ 覆盖（bin\java.exe 必须存在）。
  ) else (
    echo          处理：重新运行 scripts\install-jre.bat 覆盖安装，
    echo                或把 Temurin 25 JRE 解压到 jre\（bin\java.exe 必须存在）。
  )
@ exit /b 1
)
@exit /b 0