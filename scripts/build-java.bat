@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - build

@rem ================================================================
@rem  Compile java\src into java\dist\hongguo-api.jar. That is ALL
@rem  this script does.
@rem
@rem  Design rule: see the long note at the top of start.bat -- the
@rem  batch layer stays trivial, 100% ASCII, and free of PowerShell.
@rem
@rem  A JDK is required, not just a JRE: javac and jar ship only with
@rem  the JDK. The release package ships a prebuilt jar, so this is
@rem  only needed after changing sources.
@rem
@rem  Pass -Dxxx=yyy to forward a system property into the running
@rem  server later; that is only a convenience, nothing reads it here.
@rem ================================================================

@cd /d "%~dp0.."

@rem ROOT is the project root as an absolute path. It is used to reach
@rem server\config\config.json with a path that does not depend on the
@rem current drive, and it also feeds the error message below.
set "ROOT=%CD%"

set "SRC=java\src"
set "CLASSES=java\build\classes"
set "DIST=java\dist"
set "JAR=java\dist\hongguo-api.jar"

if not exist "%SRC%\com\hongguo\api\Main.java" goto :no_root

@rem --- locate a JDK --------------------------------------------------
@rem javac and jar are looked up in the same places as java.exe so a
@rem bundled JDK wins over a stale system one.
set "JDK_BIN="
if exist "jre\bin\javac.exe" set "JDK_BIN=jre\bin\"
if not defined JDK_BIN for /d %%d in ("jre\*") do @if not defined JDK_BIN if exist "%%~fd\bin\javac.exe" set "JDK_BIN=%%~fd\bin\"
if not defined JDK_BIN if defined JAVA_HOME if exist "%JAVA_HOME%\bin\javac.exe" set "JDK_BIN=%JAVA_HOME%\bin\"
@rem %%~$dpp already ends with a backslash. If javac.exe is not on PATH
@rem the modifier leaves the literal name behind, and the exist check
@rem below turns that into the "no JDK" branch.
if not defined JDK_BIN for %%p in (javac.exe) do set "JDK_BIN=%%~$dpp"

if not defined JDK_BIN goto :no_jdk
if not exist "%JDK_BIN%javac.exe" goto :no_jdk

@rem --- 1/2 compile ---------------------------------------------------
echo.
echo   [1/2] Compiling...
if exist "java\build" rmdir /s /q "java\build"
mkdir "%CLASSES%" 2>nul
if not exist "%CLASSES%" goto :no_classes
mkdir "%DIST%" 2>nul
if not exist "%DIST%" goto :no_dist

if exist "%SRC%" for /r "%SRC%" %%f in (*.java) do >>"java\build\sources.txt" echo %%f
if not exist "java\build\sources.txt" goto :no_sources

"%JDK_BIN%javac.exe" -encoding UTF-8 -d "%CLASSES%" @"java\build\sources.txt"
if errorlevel 1 goto :compile_failed

@rem --- 2/2 package ---------------------------------------------------
echo   [2/2] Packaging...
if exist "java\resources" xcopy /e /i /q /y "java\resources" "%CLASSES%\" >nul

@rem Version comes from server\config\config.json so the jar manifest stays
@rem in sync with what --version prints. The nested for /f strips the key and
@rem the surrounding quotes.
@rem
@rem There is deliberately no hard-coded fallback number: that would copy the
@rem version into this script, so bumping it would mean editing two places
@rem again. A missing version is a broken config, so fail loudly instead of
@rem stamping a stale number into the jar.
@set "VERSION="
@for /f "tokens=2 delims=:,}" %%v in ('findstr /r /c:"\"version\"" "%ROOT%\server\config\config.json" 2^>nul') do @set "VERSION=%%~v"
if not defined VERSION goto :no_version
echo         version %VERSION%

(
  echo Main-Class: com.hongguo.api.Main
  echo Implementation-Title: hongguo-api
  echo Implementation-Version: %VERSION%
) > "java\build\manifest.txt"

if exist "%JAR%" del "%JAR%"

@rem jar.exe is called from its full path rather than as a bare "jar":
@rem on a machine with only a JRE on PATH, the bare name would not
@rem resolve even though we already know where the JDK lives.
pushd "%CLASSES%"
if errorlevel 1 goto :no_pushd
"%JDK_BIN%jar.exe" --create --file "..\..\%JAR%" --manifest "..\manifest.txt" .
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" goto :jar_failed

for %%f in ("%JAR%") do set "SIZE=%%~zf"
@rem set /a, not plain set: "set V=1024 / 1024" would store the literal
@rem text "1024 / 1024" rather than evaluating the division.
set /a SIZE_KB=%SIZE% / 1024
echo.
echo   Built %CD%\%JAR% (%SIZE_KB% KB)
echo   Start it with scripts\start.bat
echo.
pause
exit /b 0

@rem --- failure exits -------------------------------------------------
:no_root
echo.
echo   %CD%\%SRC% does not look like the source tree -- Main.java is
echo   missing. Run this from inside a full copy of the project.
echo.
pause
exit /b 1

:no_jdk
echo.
echo   No JDK found on this machine (javac.exe is missing).
echo   Install Temurin JDK 17+ from https://adoptium.net/ and retry.
echo   Only a JRE was found, and a JRE cannot compile Java sources.
echo.
pause
exit /b 1

:no_classes
echo.
echo   Cannot create %CD%\%CLASSES%
echo   Check that java\build is writable.
echo.
pause
exit /b 1

:no_dist
echo.
echo   Cannot create %CD%\%DIST%
echo   Check that java\dist is writable.
echo.
pause
exit /b 1

:no_sources
echo.
echo   No .java files found under %SRC% -- nothing to compile.
echo.
pause
exit /b 1

:compile_failed
echo.
echo   Compilation failed. Errors are listed above.
echo.
pause
exit /b 1

:no_version
echo.
echo   Could not read the version field from
echo     %ROOT%\server\config\config.json
echo   Add a line like  "version": "x.y.z"  at the top level of that file
echo   and run this script again.
echo.
pause
exit /b 1

:no_pushd
echo.
echo   Cannot enter %CD%\%CLASSES% to package.
echo.
pause
exit /b 1

:jar_failed
echo.
echo   Packaging failed. Run scripts\build-java.bat from a terminal
echo   that shows the full jar output for the reason.
echo.
pause
exit /b 1
