@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web

@rem ================================================================
@rem  Launch the API server. That is ALL this script does.
@rem
@rem  Design rule: the batch layer must stay trivial. cmd.exe parses
@rem  a batch file with a fixed-size buffer and tracks its position by
@rem  byte offset; a multi-byte character split at a buffer boundary,
@rem  or a mid-run "chcp" changing the console code page, makes that
@rem  bookkeeping desynchronise. The same bytes then get read twice,
@rem  so lines print twice and the command echo leaks back as
@rem  "C:\...>echo." garbage. Every non-trivial branch kept in cmd is
@rem  a branch that can trip over that.
@rem
@rem  So this file is 100% ASCII and contains no "chcp". It never
@rem  parses JSON, never passes a port on the command line, and never
@rem  decides anything. Configuration lives in
@rem  server\config\config.json and is read by the Java side.
@rem
@rem  Responsibilities kept here, because they cannot live in Java:
@rem    1. locate a JRE -- a JVM is needed before any Java code runs
@rem    2. run install-jre.bat when there is none
@rem    3. start the jar
@rem
@rem  Switches are passed straight through to the jar; see --help.
@rem ================================================================

@cd /d "%~dp0.."

set "JAR=java\dist\hongguo-api.jar"

@rem --- locate a JRE -------------------------------------------------
@rem The order mirrors Java's Launcher.findJava: the bundled jre\ wins
@rem over JAVA_HOME, which wins over PATH. Preferring the bundled copy
@rem keeps a stale system JDK (8/11) from being picked first, which
@rem would break unidbg.
set "JAVA_BIN="
if exist "jre\bin\java.exe" set "JAVA_BIN=%CD%\jre\bin\java.exe"
if not defined JAVA_BIN for /d %%d in ("jre\*") do @if not defined JAVA_BIN if exist "%%~fd\bin\java.exe" set "JAVA_BIN=%%~fd\bin\java.exe"
if not defined JAVA_BIN if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JAVA_BIN=%JAVA_HOME%\bin\java.exe"
if not defined JAVA_BIN for %%p in (java.exe) do set "JAVA_BIN=%%~$PATH:p"
if not defined JAVA_BIN goto :need_jre

@rem --- jar present? -------------------------------------------------
@rem Building is NOT done here on purpose: compiling needs a JDK, while
@rem this machine may only have a JRE. The Java side reports this case
@rem with an actionable message instead.
if not exist "%JAR%" goto :no_jar
goto :run

@rem --- run ------------------------------------------------------------
@rem -Dstdout/-Dstderr pin the JVM's own streams to UTF-8; without them a
@rem Windows console decodes the Chinese output as GBK. The jar also
@rem calls Log.initEncoding(); this is the belt to that pair of braces.
:run
"%JAVA_BIN%" -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar "%JAR%" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :exited
echo.
echo   Service stopped normally.
pause
exit /b 0

@rem --- no JRE: install one, then retry -------------------------------
@rem HG_SKIP_JRE_INSTALL=1 opts out of the download. This one setting
@rem stays on the environment rather than in config.json because it
@rem must be read BEFORE any JVM exists -- a file the JVM would parse
@rem is no use to a machine that has no Java to read it with.
:need_jre
if defined HG_SKIP_JRE_INSTALL goto :install_skipped
echo.
echo   No Java runtime found on this machine.
echo   Running scripts\install-jre.bat to fetch Temurin JRE 25 LTS...
echo.
call "%~dp0install-jre.bat"
if errorlevel 1 goto :install_failed
@rem install-jre.bat extracted into jre\; re-resolve before retrying.
set "JAVA_BIN="
if exist "jre\bin\java.exe" set "JAVA_BIN=%CD%\jre\bin\java.exe"
if not defined JAVA_BIN for /d %%d in ("jre\*") do @if not defined JAVA_BIN if exist "%%~fd\bin\java.exe" set "JAVA_BIN=%%~fd\bin\java.exe"
if not defined JAVA_BIN goto :install_failed
if not exist "%JAR%" goto :no_jar
goto :run

:install_skipped
echo.
echo   No Java runtime found, and HG_SKIP_JRE_INSTALL is set, so no
echo   download was attempted.
echo.
echo   Either unset it and run this script again, or install Temurin
echo   17+ from https://adoptium.net/ , or unpack a JRE into the jre\
echo   folder by hand (it needs bin\java.exe inside).
echo.
pause
exit /b 1

@rem --- failure exits -------------------------------------------------
:install_failed
echo.
echo   Java runtime is still unavailable, cannot start.
echo   Install Temurin 17+ from https://adoptium.net/ and retry, or
echo   unpack a JRE into the jre\ folder (needs bin\java.exe).
echo.
pause
exit /b 1

:no_jar
echo.
echo   Missing %CD%\%JAR%
echo.
echo   The release package ships a prebuilt jar, so it is missing here
echo   because the package was extracted incompletely. If you are
echo   building from source, install JDK 17+ and run:
echo       scripts\build-java.bat
echo.
pause
exit /b 1

:exited
echo.
echo   Service exited with code %RC%.
echo   Scroll up for the reason.
echo.
pause
exit /b %RC%
