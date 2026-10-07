@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - stop

@rem ================================================================
@rem  Stop the running services. That is ALL this script does.
@rem
@rem  Design rule: see the long note at the top of start.bat. In
@rem  short -- the batch layer stays trivial and 100% ASCII, because
@rem  every non-trivial branch in cmd is a branch that can trip over
@rem  the byte-offset bookkeeping and start printing lines twice.
@rem
@rem  So this file does not parse JSON, does not scan processes, and
@rem  does not check ports. It hands "--stop" to the jar and lets the
@rem  Java side do the work: the ports it reports on come from
@rem  server\config\config.json, and reading that here would mean
@rem  keeping a second copy of the config parser in cmd.
@rem ================================================================

@cd /d "%~dp0.."

set "JAR=java\dist\hongguo-api.jar"

@rem --- locate a JRE -------------------------------------------------
@rem Needed only to run the jar. Same order as Java's Launcher.findJava:
@rem the bundled jre\ wins over JAVA_HOME, which wins over PATH.
set "JAVA_BIN="
if exist "jre\bin\java.exe" set "JAVA_BIN=%CD%\jre\bin\java.exe"
if not defined JAVA_BIN for /d %%d in ("jre\*") do @if not defined JAVA_BIN if exist "%%~fd\bin\java.exe" set "JAVA_BIN=%%~fd\bin\java.exe"
if not defined JAVA_BIN if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JAVA_BIN=%JAVA_HOME%\bin\java.exe"
if not defined JAVA_BIN for %%p in (java.exe) do set "JAVA_BIN=%%~$PATH:p"
if not defined JAVA_BIN goto :need_jre

if not exist "%JAR%" goto :no_jar
goto :run

:run
@rem --stop always exits 0: "stopped it" and "nothing was running"
@rem are both normal outcomes of an idempotent stop.
"%JAVA_BIN%" -jar "%JAR%" --stop
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :failed
echo.
echo   Stop request finished.
pause
exit /b 0

:failed
echo.
echo   Stop failed with code %RC%.
echo   Scroll up for the reason.
echo.
pause
exit /b %RC%

:need_jre
echo.
echo   No Java runtime found, so there is no way to run the stop command.
echo   If services are running you can end them by hand: open Task Manager,
echo   select any "java.exe" started from this folder, and end the task.
echo.
pause
exit /b 1

:no_jar
echo.
echo   Missing %CD%\%JAR%
echo.
echo   Nothing to stop through this script. If the service is running from
echo   another copy of the project, stop it there instead.
echo.
pause
exit /b 1
