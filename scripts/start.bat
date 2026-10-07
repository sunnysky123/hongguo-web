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
@rem    2. start the jar
@rem
@rem  The release package ships a matching JRE, so step 1 normally hits
@rem  jre\ on the first try. There is no download step: scripts\install-jre.bat
@rem  used to live here, but packaging now fetches the JRE per platform
@rem  (see scripts\pack.sh), and a repository checkout no longer carries one.
@rem  A machine without any Java is told how to fix that and stops.
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
@rem No encoding flags here on purpose. A Chinese Windows console runs
@rem code page 936 (GBK), and the JVM already matches its output to the
@rem console. Forcing -Dstdout.encoding=UTF-8 makes the JVM emit UTF-8
@rem bytes that the console then decodes as GBK -- every character turns
@rem into mojibake such as "Java<EF80><EF80><EF80>re\bin\java.exe".
@rem Set HG_LOG_ENCODING if some other target needs a specific charset.
:run
"%JAVA_BIN%" -jar "%JAR%" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :exited
echo.
echo   Service stopped normally.
pause
exit /b 0

@rem --- no JRE: explain how to get one, then stop ----------------------
@rem This used to shell out to install-jre.bat and retry afterwards.
@rem That script is gone: the JRE now arrives inside each release package
@rem (pack.sh fetches the right build per platform), so the only machines
@rem landing here are source checkouts with no Java at all. Downloading a
@rem runtime silently from within a launcher is the wrong default -- it
@rem turns a clear "you are missing Java" into a slow, network-dependent
@rem failure. So: say what is missing, say how to fix it, stop.
@rem
@rem HG_SKIP_JRE_INSTALL is intentionally NOT honoured here. It used to
@rem suppress the bundled download; with no download to suppress it would
@rem be a flag that does nothing, so a stale value in the environment
@rem would read as if it still had meaning.
:need_jre
echo.
echo   No Java runtime found on this machine.
echo.
echo   Release packages include a matching JRE, so this normally means you
echo   are running from a source checkout. Either:
echo.
echo     1) Install Temurin 17+ from https://adoptium.net/  ^(recommended^)
echo     2) Unpack any JRE 17+ into the jre\ folder   ^(needs bin\java.exe^)
echo.
echo   Then run this script again.
echo.
pause
exit /b 1

@rem --- failure exits -------------------------------------------------
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
