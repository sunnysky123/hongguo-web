@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - build

@rem ================================================================
@rem Pure ASCII on purpose: see the long note at the top of start.bat.
@rem All CJK comes from msg.ps1 via the :say helper.
@rem ================================================================

@cd /d "%~dp0.."
@set "CD=%CD%"

:say
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg.ps1" -Key "%~1"
@exit /b %ERRORLEVEL%

@call :say init

@if not exist "java\src\com\hongguo\api\Main.java" (
  @call :say build.no_root
  @echo.
  @pause
  @exit /b 1
)

@call :say build.banner

@set "JAVAC_BIN="
@set "JDK_BIN="

@if exist "jre\bin\javac.exe" goto :bundled_jdk
@for /d %%d in ("jre\*") do @if not defined JAVAC_BIN if exist "%%~fd\bin\javac.exe" (
  @set "JAVAC_BIN=%%~fd\bin\javac.exe"
  @set "JDK_BIN=%%~fd\bin\"
  @call :say build.jdk_bundled_deep
  @goto :compile
)
@if defined JAVAC_BIN goto :compile

@if defined JAVA_HOME if exist "%JAVA_HOME%\bin\javac.exe" (
  @set "JAVAC_BIN=%JAVA_HOME%\bin\javac.exe"
  @set "JDK_BIN=%JAVA_HOME%\bin\"
  @call :say build.jdk_javahome
  @goto :compile
)

@where javac >nul 2>&1
@if errorlevel 1 goto :no_jdk
@for %%i in (javac.exe) do set "JDK_BIN=%%~dp$PATH:i"
@set "JAVAC_BIN=%JDK_BIN%javac.exe"
@call :say build.jdk_path
@goto :compile

:bundled_jdk
@set "JAVAC_BIN=%CD%\jre\bin\javac.exe"
@set "JDK_BIN=%CD%\jre\bin\"
@call :say build.jdk_bundled
@goto :compile

:no_jdk
@call :say build.no_jdk
@pause
@exit /b 1

:compile
@"%JAVAC_BIN%" -version 2>&1 | findstr /r "javac" >nul 2>&1
@if errorlevel 1 @call :say build.javac_warn

@call :say build.step1
@if exist "java\build" rmdir /s /q "java\build"
@mkdir "java\build\classes" 2>nul
@if not exist "java\build\classes" (
  @call :say build.no_classes
  @pause
  @exit /b 1
)
@mkdir "java\dist" 2>nul
@if not exist "java\dist" (
  @call :say build.no_dist
  @pause
  @exit /b 1
)

@if exist "java\build\sources.txt" del "java\build\sources.txt"
@for /r "java\src" %%f in (*.java) do >>"java\build\sources.txt" echo %%f

@if not exist "java\build\sources.txt" (
  @call :say build.no_sources
  @pause
  @exit /b 1
)

@for /f %%c in ('find /v /c "" ^< "java\build\sources.txt"') do set "CNT=%%c"
@call :say build.cnt

@"%JAVAC_BIN%" -encoding UTF-8 -d "java\build\classes" @"java\build\sources.txt"
@if errorlevel 1 (
  @call :say build.compile_fail
  @pause
  @exit /b 1
)

@call :say build.step2
@if exist "java\resources" xcopy /e /i /q /y "java\resources" "java\build\classes\" >nul

@(
  echo Main-Class: com.hongguo.api.Main
  echo Implementation-Title: hongguo-api
  echo Implementation-Version: 1.0.0
) > "java\build\manifest.txt"

@if exist "java\dist\hongguo-api.jar" del "java\dist\hongguo-api.jar"

@pushd "java\build\classes"
@if errorlevel 1 (
  @call :say build.pushd_fail
  @pause
  @exit /b 1
)

@if exist "%JDK_BIN%jar.exe" (
  @"%JDK_BIN%jar.exe" --create --file "..\..\java\dist\hongguo-api.jar" --manifest "..\manifest.txt" .
) else (
  @jar --create --file "..\..\java\dist\hongguo-api.jar" --manifest "..\manifest.txt" .
)
@set "RC=%ERRORLEVEL%"
@popd

@if not "%RC%"=="0" (
  @call :say build.jar_fail
  @exit /b 1
)

@for %%f in ("java\dist\hongguo-api.jar") do set "SIZE=%%~zf"
@set /a SIZE_KB=%SIZE% / 1024

@call :say build.done
@exit /b 0
