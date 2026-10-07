@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - signer

@rem ================================================================
@rem Pure ASCII on purpose: see the long note at the top of start.bat.
@rem All CJK comes from msg.ps1.
@rem
@rem Note the second trap documented there: "call :sub <arg>" inside an
@rem if (...) block loses the argument, so the messages that used to sit
@rem inside blocks are reached by "goto :say_xxx" instead.
@rem ================================================================

@cd /d "%~dp0..\signer"
@set "CD=%CD%"

@call :say init
@goto :main

:say
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg.ps1" -Key "%~1"
@exit /b %ERRORLEVEL%

:say_no_java
@call :say sign.no_java
@pause
@exit /b 1

:say_jre_old
@call :say sign.jre_old
@pause
@exit /b 1

:cfg_read
@rem Signer port follows server\config\config.json; CLI arg wins.
@rem Read it through a temp file instead of "for /f with backticks inside
@rem an if (...) block": cmd treats the PowerShell pipe as the end of the
@rem block and truncates it, leaving SIGN_PORT empty.
@set SIGN_PORT=9099
@set "HG_CFG_DUMP=%TEMP%\hongguo_sign_%RANDOM%.txt"
@powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $j = Get-Content -Raw '..\server\config\config.json' | ConvertFrom-Json; 'SIGN_PORT=' + $j.signer.port" > "%HG_CFG_DUMP%" 2>nul
@if exist "%HG_CFG_DUMP%" for /f "usebackq tokens=1,* delims==" %%A in ("%HG_CFG_DUMP%") do @if /i "%%A"=="SIGN_PORT" set "SIGN_PORT=%%B"
@del /q "%HG_CFG_DUMP%" >nul 2>&1
@set "HG_CFG_DUMP="
@if not defined SIGN_PORT set "SIGN_PORT=9099"
@if not "%~1"=="" set "SIGN_PORT=%~1"
@exit /b 0

:find_java
@set "JAVA_BIN="
@if exist "jre\bin\java.exe" goto :bundled_jre
@where java >nul 2>&1
@if errorlevel 1 goto :say_no_java
@for /f "delims=" %%j in ('where java') do @if not defined JAVA_BIN set "JAVA_BIN=%%j"
@call :say sign.jre_system
@exit /b 0

:bundled_jre
@set "JAVA_BIN=%CD%\jre\bin\java.exe"
@call :say sign.jre_bundled
@exit /b 0

:main
@call :cfg_read
@call :say sign.banner
@call :say sign.hint

@call :find_java
@if errorlevel 1 exit /b 1

@call :say sign.run_header

@set JAVA_MAJOR=0
@for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /r "version \"[0-9]"') do @set "JAVA_MAJOR=%%~v"
@set "JAVA_MAJOR=%JAVA_MAJOR:v=%"
@if %JAVA_MAJOR% LSS 17 goto :say_jre_old

@set NATIVE_ACCESS=
@if %JAVA_MAJOR% GEQ 24 set NATIVE_ACCESS=--enable-native-access=ALL-UNNAMED

@rem The signer always binds to the loopback address: it only serves
@rem the local API. Set it explicitly so an inherited BIND_HOST -- which
@rem may be a hostname that fails to resolve -- cannot leak in.
@set "BIND_HOST=127.0.0.1"

@java --add-opens java.base/java.lang=ALL-UNNAMED %NATIVE_ACCESS% -Xmx512m -cp unidbg-sign.jar com.hongguo.sign.FqTrace serve %SIGN_PORT%

@call :say sign.exited
@pause
@exit /b 0
