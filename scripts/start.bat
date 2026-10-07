@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web

@rem ================================================================
@rem This file is deliberately 100% ASCII -- no CJK, no "chcp".
@rem
@rem cmd.exe reads a batch file through a fixed-size buffer and tracks
@rem its position by byte offset. Two things break that bookkeeping:
@rem   1) a multi-byte character split by the buffer boundary
@rem   2) "chcp" changing the console code page mid-run, which makes
@rem      cmd seek with a stale offset
@rem Either one makes cmd re-read bytes it already consumed, so a line
@rem prints twice and the command echo leaks back as
@rem "C:\...>echo." garbage. It is a cmd.exe internal, not a script bug.
@rem
@rem So cmd never handles CJK here. All Chinese text lives in msg.ps1
@rem (UTF-8 with BOM) and is printed by PowerShell, which sets the
@rem console code page itself. Everything below is ASCII.
@rem
@rem SECOND cmd TRAP, learned the hard way: "call :sub <arg>" inside an
@rem if (...) block loses the argument. cmd parses the whole block into
@rem a single compound command first, and the subroutine argument never
@rem arrives -- msg.ps1 then gets -Key "" and aborts. So NO "call :say"
@rem ever appears inside parentheses. Each message has its own ":say_*"
@rem label reached by "goto", and control returns to a continuation
@rem label afterwards.
@rem ================================================================

@cd /d "%~dp0.."

@set "SCRIPT_ARG=%~1"
@if not exist "server\data\log" mkdir "server\data\log"
@set "LOG_FILE=server\data\log\start.log"
@set "HG_LOG_ABS=%CD%\%LOG_FILE%"
@set "CD=%CD%"

@call :say init
@goto :main

@rem ---------------------------------------------------------------
@rem Message printer. Always invoked as a plain "call :say <key>" at
@rem top level (never inside parentheses). The :say_xxx labels below
@rem wrap the ones that used to sit inside if (...) blocks.
@rem ---------------------------------------------------------------
:say
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg.ps1" -Key "%~1"
@exit /b %ERRORLEVEL%

:start_abort
@call :say start.abort
@pause
@exit /b 1

:start_exit_err
@call :say start.exit_err
@pause
@exit /b %RC%

:prep_no_java
@call :say prepare.no_java
@exit /b 1

:prep_no_jar
@call :say prepare.no_jar
@exit /b 1

:prep_build_fail
@call :say prepare.build_fail
@exit /b 1

@rem ================================================================
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
@rem ================================================================
:read_config
@rem -- Save user env var first: HG_OPEN_BROWSER=0 disables auto-open
@set "HG_OPEN_BROWSER_ENV=%HG_OPEN_BROWSER%"
@set "HG_CFG_DUMP=%TEMP%\hongguo_cfg_%RANDOM%.txt"
@powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $j = Get-Content -Raw 'server\config\config.json' | ConvertFrom-Json; 'HOST=' + $j.api.host; 'PORT=' + $j.api.port; 'SIGN_PORT=' + $j.signer.port; 'SIGN_ENABLED=' + $j.signer.enabled; 'OPEN_BROWSER=' + $j.launcher.open_browser; 'SKIP_JRE=' + $j.launcher.skip_jre_install" > "%HG_CFG_DUMP%" 2>nul
@rem Dump each key to its own HG_CFG_<KEY> var in one flat pass.
@rem A "for /f ... do call :sub" nested inside another call is unsafe:
@rem "goto :eof" returns only ONE level, so the call stack gets
@rem corrupted. Writing the name dynamically keeps it a single loop.
@if exist "%HG_CFG_DUMP%" for /f "usebackq tokens=1,* delims==" %%A in ("%HG_CFG_DUMP%") do @set "HG_CFG_%%A=%%B"
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

@rem ---------------------------------------------------------------
@rem Main flow
@rem ---------------------------------------------------------------
:main
@call :read_config
@call :prepare 1>>"%LOG_FILE%" 2>&1
@if errorlevel 1 goto :start_abort
@call :say start.banner

@set "JAR_ARGS="
@if /i "%MODE%"=="nosign"   set "JAR_ARGS=--no-sign"
@if /i "%MODE%"=="signonly" set "JAR_ARGS=--sign-only"

@java -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar java\dist\hongguo-api.jar %JAR_ARGS% --port %SIGN_PORT%
@set "RC=%ERRORLEVEL%"
@set "HG_STAMP=%DATE% %TIME%"
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg.ps1" -Key start.log_tail >>"%LOG_FILE%"
@if not "%RC%"=="0" goto :start_exit_err
@call :say start.stopped
@pause
@exit /b 0

@rem ---------------------------------------------------------------
@rem :prepare -- console output goes to the launcher log via the
@rem caller's redirection, so plain echo is fine here (ASCII only).
@rem ---------------------------------------------------------------
:prepare
@set "HG_STAMP=%DATE% %TIME%"
@call :say start.log_head
@call :say blank

@call :ensure_java
@if errorlevel 1 goto :prep_no_java
@echo   [1/4] Java %JAVAVER% (%JAVA_SRC%)

@if not exist "signer\unidbg-sign.jar" goto :prep_no_jar
@if not exist "capture\fq_oversea\libmetasec_ml.so"    goto :missing_so
@if not exist "capture\fq_oversea\libc++_shared.so"    goto :missing_so
@if not exist "capture\fq_oversea\ms_16777218.bin"      goto :missing_so
@echo   [2/4] signer assets ready
@goto :after_so

:missing_so
@call :say prepare.no_so
@exit /b 1

:after_so
@if exist "java\dist\hongguo-api.jar" goto :jar_ready
@echo   [3/4] API service JAR missing, building...
@call "%~dp0build-java.bat"
@if errorlevel 1 goto :prep_build_fail
@echo   [3/4] build finished
@goto :jar_ready_done

:jar_ready
@echo   [3/4] API service JAR ready

:jar_ready_done

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
@set "HG_BROWSER_URL="
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
@set "HG_BROWSER_URL=%OPEN_URL%"
@echo   [browser] will open %OPEN_URL% when ready
@rem Poll /health until 200, then open the browser: full mode waits for
@rem unidbg init (10-30s), a fixed delay would hit a blank page.
@rem 400 tries * (500ms + up to 2s timeout) covers a ~90s init window.
@start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$u='%OPEN_URL%';$h=$u+'health';for($i=0;$i -lt 400;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -Uri $h -TimeoutSec 2;if($r.StatusCode -eq 200){Start-Process $u;break}}catch{};Start-Sleep -Milliseconds 500}"

:no_browser
@echo   [4/4] handoff to hongguo-api.jar
@echo   API port %PORT%   signer port %SIGN_PORT%   mode %MODE%
@exit /b 0

@rem ---------------------------------------------------------------
@rem :ensure_java -- locate a JRE 17+, installing one if allowed.
@rem
@rem Self-contained on purpose. A "goto" to a label OUTSIDE this
@rem subroutine would unwind the call stack at once, so returning to
@rem :prepare would be skipped entirely and control would fall into
@rem the main flow. Every label below therefore carries the ej_ prefix
@rem and the only exits are "exit /b 0/1".
@rem ---------------------------------------------------------------
:ensure_java
@set "BUNDLED_BIN="
@if exist "jre\bin\java.exe" set "BUNDLED_BIN=%CD%\jre\bin"
@if not defined BUNDLED_BIN for /d %%d in ("jre\*") do (
@ if not defined BUNDLED_BIN if exist "%%~fd\bin\java.exe" set "BUNDLED_BIN=%%~fd\bin"
)
@if defined BUNDLED_BIN goto :ej_bundled

@if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" goto :ej_java_home
@goto :ej_probe_path

:ej_bundled
@set "PATH=%BUNDLED_BIN%;%PATH%"
@call :say prepare.jre_src_bundled
@set "JAVA_FROM_BUNDLED=1"
@goto :ej_check_version

:ej_java_home
@set "PATH=%JAVA_HOME%\bin;%PATH%"
@set "JAVA_SRC=JAVA_HOME"
@goto :ej_check_version

:ej_probe_path
@where java >nul 2>&1
@if errorlevel 1 goto :ej_no_java_on_path
@set "JAVA_SRC=system PATH"
@goto :ej_check_version

:ej_no_java_on_path
@if /i "%HG_SKIP_JRE_INSTALL%"=="1" goto :ej_skip_install
@goto :ej_do_install

:ej_skip_install
@call :say prepare.jre_skip
@exit /b 1

:ej_do_install
@call :say prepare.jre_installing
@set "HG_ASSUME_YES=1"
@call "%~dp0install-jre.bat"
@set "HG_ASSUME_YES="
@if errorlevel 1 goto :ej_install_failed

@set "JAVA_DIR="
@if exist "%ProgramFiles%\Eclipse Adoptium\jdk-25\bin\java.exe" set "JAVA_DIR=%ProgramFiles%\Eclipse Adoptium\jdk-25"
@if not defined JAVA_DIR if exist "%ProgramFiles%\Java\jdk-25\bin\java.exe" set "JAVA_DIR=%ProgramFiles%\Java\jdk-25"
@if not defined JAVA_DIR if exist "%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-25\bin\java.exe" set "JAVA_DIR=%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-25"
@if not defined JAVA_DIR goto :ej_verify_java
@set "PATH=%JAVA_DIR%\bin;%PATH%"
@set "JAVA_SRC=install dir"
@call :say prepare.jre_refresh

:ej_verify_java
@where java >nul 2>&1
@if errorlevel 1 goto :ej_still_missing
@goto :ej_check_version

:ej_install_failed
@call :say prepare.jre_fail
@exit /b 1

:ej_still_missing
@call :say prepare.jre_still_missing
@exit /b 1

:ej_check_version
@set JAVAVER=unknown
@for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /r "version ""[0-9]"') do @set "JAVAVER=%%~v"
@set "JAVAVER=%JAVAVER:v=%"

@set JAVA_MAJOR=0
@for /f "tokens=1 delims=." %%m in ("%JAVAVER%") do set "JAVA_MAJOR=%%m"
@if %JAVA_MAJOR% LSS 17 goto :ej_too_old
@exit /b 0

:ej_too_old
@call :say prepare.jre_too_old
@call :say prepare.jre_too_old_fix
@exit /b 1
