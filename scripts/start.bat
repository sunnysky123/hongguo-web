@echo off
@chcp 65001 >nul 2>&1
@setlocal DisableDelayedExpansion
@title 红果短剧 - 网页版

@cd /d "%~dp0.."

@set "SCRIPT_ARG=%~1"
@if not exist "server\data\log" mkdir "server\data\log"
@set "LOG_FILE=server\data\log\start.log"

@call :read_config
@call :prepare 1>>"%LOG_FILE%" 2>&1
@if errorlevel 1 (
  echo.
  echo   [启动中止] 详见日志文件：%CD%\%LOG_FILE%
  echo.
@ pause
@ exit /b 1
)

echo.
echo   正在启动，稍后浏览器会自动打开：%OPEN_URL%
echo   启动器日志：%CD%\%LOG_FILE%
echo.

@set "JAR_ARGS="
@if /i "%MODE%"=="nosign"   set "JAR_ARGS=--no-sign"
@if /i "%MODE%"=="signonly" set "JAR_ARGS=--sign-only"

@java -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar java\dist\hongguo-api.jar %JAR_ARGS% --port %SIGN_PORT%
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

@rem ============================================================
@rem Read settings from server\config\config.json.
@rem JAR-side Config priority is ENV > config file, so we export the
@rem settings as env vars. setx only affects future processes, so plain
@rem set is required for the java child started later in this script.
@rem Config values apply only when a var is undefined OR empty, so any
@rem env var already set by the user keeps priority.
@rem
@rem We launch PowerShell exactly once to read everything at once:
@rem  - saves 6 process spawns (200-500ms each)
@rem  - avoids "multi-line for /f with backticks and a PowerShell pipe
@rem    inside an if (...) block", which cmd truncates at the pipe byte.
@rem    That bug left BIND_HOST/PORT empty, so the URL became
@rem    http://:/ and the browser never opened.
@rem
@rem NOTE: keep every rem comment line pure ASCII. cmd.exe scans a rem
@rem line byte by byte to find its end; if the console code page and the
@rem file encoding disagree, a multi-byte sequence can be mistaken for a
@rem command separator and the tail of the comment gets executed.
@rem ============================================================
:read_config
@rem -- Save user env var first: HG_OPEN_BROWSER=0 disables auto-open
@set "HG_OPEN_BROWSER_ENV=%HG_OPEN_BROWSER%"
@set "HG_CFG_DUMP=%TEMP%\hongguo_cfg_%RANDOM%.txt"
@powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $j = Get-Content -Raw 'server\config\config.json' | ConvertFrom-Json; 'HG_HOST=' + $j.api.host; 'HG_PORT=' + $j.api.port; 'HG_SIGN_PORT=' + $j.signer.port; 'HG_SIGN_ENABLED=' + $j.signer.enabled; 'HG_OPEN_BROWSER=' + $j.launcher.open_browser; 'HG_SKIP_JRE=' + $j.launcher.skip_jre_install" > "%HG_CFG_DUMP%" 2>nul
@if exist "%HG_CFG_DUMP%" for /f "usebackq tokens=1,* delims==" %%A in ("%HG_CFG_DUMP%") do @call :cfg_apply "%%A" "%%B"
@del /q "%HG_CFG_DUMP%" >nul 2>&1
@set "HG_CFG_DUMP="

@rem -- Listen IP: api.host -> BIND_HOST
@rem Test "undefined OR empty" instead of "if not defined": plain
@rem 'set "X="' clears a var but it still counts as DEFINED, so
@rem "if not defined" misses that case and the URL ends up with an
@rem empty host/port.
@if not defined BIND_HOST set "BIND_HOST=%HG_CFG_HOST%"
@if not defined BIND_HOST set "BIND_HOST=127.0.0.1"

@rem -- API port: api.port -> PORT
@if not defined PORT set "PORT=%HG_CFG_PORT%"
@if not defined PORT set "PORT=8000"

@rem -- Signer port: signer.port -> SIGN_PORT
@if not defined SIGN_PORT set "SIGN_PORT=%HG_CFG_SIGN_PORT%"
@if not defined SIGN_PORT set "SIGN_PORT=9099"

@rem -- Signer on/off: signer.enabled (false => no-sign mode)
@if not defined SIGN_ENABLED set "SIGN_ENABLED=%HG_CFG_SIGN_ENABLED%"
@if not defined SIGN_ENABLED set "SIGN_ENABLED=True"

@rem -- Auto-open browser: launcher.open_browser
@if not defined OPEN_BROWSER set "OPEN_BROWSER=%HG_CFG_OPEN_BROWSER%"
@if not defined OPEN_BROWSER set "OPEN_BROWSER=True"

@rem -- Skip auto JRE install when Java is missing: launcher.skip_jre_install
@set "HG_SKIP_JRE_INSTALL=0"
@if /i "%HG_CFG_SKIP_JRE%"=="True" set "HG_SKIP_JRE_INSTALL=1"
@exit /b 0

:cfg_apply
@if /i "%~1"=="HG_HOST"         set "HG_CFG_HOST=%~2"
@if /i "%~1"=="HG_PORT"         set "HG_CFG_PORT=%~2"
@if /i "%~1"=="HG_SIGN_PORT"    set "HG_CFG_SIGN_PORT=%~2"
@if /i "%~1"=="HG_SIGN_ENABLED" set "HG_CFG_SIGN_ENABLED=%~2"
@if /i "%~1"=="HG_OPEN_BROWSER" set "HG_CFG_OPEN_BROWSER=%~2"
@if /i "%~1"=="HG_SKIP_JRE"     set "HG_CFG_SKIP_JRE=%~2"
@goto :eof

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

@rem Port and listen IP are already read from the config file in
@rem :read_config, so do NOT hardcode them again here. An env var that
@rem is already set is kept as-is (:read_config defaults only undefined).

@set MODE=full
@rem signer.enabled=false in config file => default to no-sign mode
@rem (a CLI argument can still override it)
@if /i "%SIGN_ENABLED%"=="False" set MODE=nosign
@if /i "%SCRIPT_ARG%"=="--no-sign"   set MODE=nosign
@if /i "%SCRIPT_ARG%"=="--sign-only" set MODE=signonly
@if /i "%MODE%"=="nosign" @set "HG_SIGN_ENABLED=0"

@rem -- Browser URL: when listening on 0.0.0.0 the browser must dial
@rem    127.0.0.1 instead, otherwise the page never loads.
@set "HG_BROWSER_HOST=%BIND_HOST%"
@if /i "%HG_BROWSER_HOST%"=="0.0.0.0" set "HG_BROWSER_HOST=127.0.0.1"
@if /i "%HG_BROWSER_HOST%"=="::"      set "HG_BROWSER_HOST=127.0.0.1"
@if not defined HG_BROWSER_HOST        set "HG_BROWSER_HOST=127.0.0.1"
@set "OPEN_URL=http://%HG_BROWSER_HOST%:%PORT%/"

@rem -- No browser in no-sign / sign-only mode: signonly runs no API
@rem    service, while nosign is left to the user's choice.
@if /i "%MODE%"=="signonly" goto :no_browser
@rem -- Normalize the switch: config file gives True/False, an env var
@rem    may give 0/1/no/off.
@set "HG_OPEN_BROWSER=1"
@if /i "%OPEN_BROWSER%"=="False" set "HG_OPEN_BROWSER=0"
@if /i "%OPEN_BROWSER%"=="0"     set "HG_OPEN_BROWSER=0"
@if /i "%OPEN_BROWSER%"=="no"    set "HG_OPEN_BROWSER=0"
@if /i "%OPEN_BROWSER%"=="off"   set "HG_OPEN_BROWSER=0"
@rem Documented contract: HG_OPEN_BROWSER=0 disables auto-open
@rem (env var takes priority over the config file)
@if /i "%HG_OPEN_BROWSER_ENV%"=="0"       set "HG_OPEN_BROWSER=0"
@if /i "%HG_OPEN_BROWSER_ENV%"=="false"   set "HG_OPEN_BROWSER=0"
@if /i "%HG_OPEN_BROWSER_ENV%"=="no"      set "HG_OPEN_BROWSER=0"
@if /i "%HG_OPEN_BROWSER_ENV%"=="off"     set "HG_OPEN_BROWSER=0"
@if "%HG_OPEN_BROWSER%"=="0" goto :no_browser
echo   [浏览器] 就绪后自动打开 %OPEN_URL%
@rem Poll /health until 200, then open the browser: full mode waits for
@rem unidbg init (10-30s), a fixed delay would hit a blank page.
@rem 400 tries * (500ms + up to 2s timeout) covers a ~90s init window.
@start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$u='%OPEN_URL%';$h=$u+'health';for($i=0;$i -lt 400;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -Uri $h -TimeoutSec 2;if($r.StatusCode -eq 200){Start-Process $u;break}}catch{};Start-Sleep -Milliseconds 500}"
:no_browser

echo   [4/4] 启动参数就绪，交由 hongguo-api.jar 运行
echo   API 端口 %PORT%   签名端口 %SIGN_PORT%   模式 %MODE%
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

@if /i "%HG_SKIP_JRE_INSTALL%"=="1" goto :skip_jre_install
@goto :do_jre_install

:skip_jre_install
  echo.
  echo   [错误] 未检测到 Java，且配置为跳过自动安装。
  echo.
  echo   请手动安装 Temurin 17 或更高版本：https://adoptium.net/
  echo   或把 JRE 解压到 jre\（要求 bin\java.exe 存在）。
@ exit /b 1

:do_jre_install

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