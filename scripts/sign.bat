@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - signer

@rem ================================================================
@rem  Run the signer service on its own. That is ALL this script does.
@rem
@rem  Design rule: see the long note at the top of start.bat. This
@rem  file stays 100% ASCII and holds no decisions beyond "is there a
@rem  JRE to run the jar with".
@rem
@rem  Notably absent: any check of the Java version and any reading
@rem  of the signer port. Both used to live here and both were wrong
@rem  to keep here:
@rem    - the version gate needs "java -version", whose output shape
@rem      differs between JDK and JRE images, and duplicating that
@rem      parse in cmd is the same fragility all over again. The jar
@rem      already probes the version properly and explains the fix.
@rem    - the port comes from server\config\config.json. Reading it
@rem      here would need a JSON parser in cmd, so the value could
@rem      silently disagree with what start.bat uses.
@rem  Pass "--port 9100" to override, or just edit the config file.
@rem ================================================================

@cd /d "%~dp0.."

set "JAR=java\dist\hongguo-api.jar"

set "JAVA_BIN="
if exist "jre\bin\java.exe" set "JAVA_BIN=%CD%\jre\bin\java.exe"
if not defined JAVA_BIN for /d %%d in ("jre\*") do @if not defined JAVA_BIN if exist "%%~fd\bin\java.exe" set "JAVA_BIN=%%~fd\bin\java.exe"
if not defined JAVA_BIN if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JAVA_BIN=%JAVA_HOME%\bin\java.exe"
if not defined JAVA_BIN for %%p in (java.exe) do set "JAVA_BIN=%%~$PATH:p"
if not defined JAVA_BIN goto :need_jre

if not exist "%JAR%" goto :no_jar
goto :run

:run
@rem --sign-only loads signer.port, signer.jvm_xmx and the asset list
@rem from config.json, then blocks. Ctrl-C stops it.
"%JAVA_BIN%" -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar "%JAR%" --sign-only %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :exited
echo.
echo   Signer stopped normally.
pause
exit /b 0

:exited
echo.
echo   Signer exited with code %RC%.
echo   Scroll up for the reason.
echo.
pause
exit /b %RC%

:need_jre
echo.
echo   No Java runtime found on this machine.
echo   Running scripts\install-jre.bat to fetch Temurin JRE 25 LTS...
echo.
call "%~dp0install-jre.bat"
if errorlevel 1 goto :install_failed
set "JAVA_BIN="
if exist "jre\bin\java.exe" set "JAVA_BIN=%CD%\jre\bin\java.exe"
if not defined JAVA_BIN for /d %%d in ("jre\*") do @if not defined JAVA_BIN if exist "%%~fd\bin\java.exe" set "JAVA_BIN=%%~fd\bin\java.exe"
if not defined JAVA_BIN goto :install_failed
if not exist "%JAR%" goto :no_jar
goto :run

:install_failed
echo.
echo   Java runtime is still unavailable, cannot start the signer.
echo   Install Temurin 17+ from https://adoptium.net/ and retry, or
echo   unpack a JRE into the jre\ folder (needs bin\java.exe).
echo.
pause
exit /b 1

:no_jar
echo.
echo   Missing %CD%\%JAR%
echo.
echo   Install JDK 17+ and run:  scripts\build-java.bat
echo.
pause
exit /b 1
