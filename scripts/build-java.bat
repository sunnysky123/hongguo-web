@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - build

@rem ================================================================
@rem Pure ASCII on purpose: see the long note at the top of start.bat.
@rem All CJK comes from msg.ps1.
@rem
@rem Note the second trap documented there: "call :sub <arg>" inside an
@rem if (...) block loses the argument, so the messages that used to sit
@rem inside blocks are reached by "goto :say_xxx" instead.
@rem ================================================================

@cd /d "%~dp0.."
@set "CD=%CD%"

@call :say init
@goto :main

:say
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg.ps1" -Key "%~1"
@exit /b %ERRORLEVEL%

:say_no_root
@call :say build.no_root
@echo.
@pause
@exit /b 1

:say_no_jdk
@call :say build.no_jdk
@pause
@exit /b 1

:say_no_classes
@call :say build.no_classes
@pause
@exit /b 1

:say_no_dist
@call :say build.no_dist
@pause
@exit /b 1

:say_no_sources
@call :say build.no_sources
@pause
@exit /b 1

:say_compile_fail
@call :say build.compile_fail
@pause
@exit /b 1

:say_pushd_fail
@call :say build.pushd_fail
@pause
@exit /b 1

:say_jar_fail
@call :say build.jar_fail
@pause
@exit /b 1

:find_jdk
@set "JAVAC_BIN="
@set "JDK_BIN="
@if exist "jre\bin\javac.exe" goto :bundled_jdk
@for /d %%d in ("jre\*") do @if not defined JAVAC_BIN if exist "%%~fd\bin\javac.exe" set "BUNDLED_JDK=%%~fd"
@if defined BUNDLED_JDK goto :bundled_jdk_deep
@if defined JAVA_HOME if exist "%JAVA_HOME%\bin\javac.exe" goto :javahome_jdk
@where javac >nul 2>&1
@if errorlevel 1 goto :say_no_jdk
@for %%i in (javac.exe) do set "JDK_BIN=%%~dp$PATH:i"
@set "JAVAC_BIN=%JDK_BIN%javac.exe"
@call :say build.jdk_path
@exit /b 0

:bundled_jdk
@set "JAVAC_BIN=%CD%\jre\bin\javac.exe"
@set "JDK_BIN=%CD%\jre\bin\"
@call :say build.jdk_bundled
@exit /b 0

:bundled_jdk_deep
@set "JAVAC_BIN=%BUNDLED_JDK%\bin\javac.exe"
@set "JDK_BIN=%BUNDLED_JDK%\bin\"
@call :say build.jdk_bundled_deep
@exit /b 0

:javahome_jdk
@set "JAVAC_BIN=%JAVA_HOME%\bin\javac.exe"
@set "JDK_BIN=%JAVA_HOME%\bin\"
@call :say build.jdk_javahome
@exit /b 0

:main
@if not exist "java\src\com\hongguo\api\Main.java" goto :say_no_root
@call :say build.banner

@call :find_jdk
@if errorlevel 1 exit /b 1

@rem -- From here on the JDK is known good; report a broken javac but go on.
@"%JAVAC_BIN%" -version 2>&1 | findstr /r "javac" >nul 2>&1
@if errorlevel 1 @call :say build.javac_warn

@call :say build.step1
@if exist "java\build" rmdir /s /q "java\build"
@mkdir "java\build\classes" 2>nul
@if not exist "java\build\classes" goto :say_no_classes
@mkdir "java\dist" 2>nul
@if not exist "java\dist" goto :say_no_dist

@if exist "java\build\sources.txt" del "java\build\sources.txt"
@for /r "java\src" %%f in (*.java) do >>"java\build\sources.txt" echo %%f

@if not exist "java\build\sources.txt" goto :say_no_sources

@for /f %%c in ('find /v /c "" ^< "java\build\sources.txt"') do set "CNT=%%c"
@call :say build.cnt

@"%JAVAC_BIN%" -encoding UTF-8 -d "java\build\classes" @"java\build\sources.txt"
@if errorlevel 1 goto :say_compile_fail

@call :say build.step2
@if exist "java\resources" xcopy /e /i /q /y "java\resources" "java\build\classes\" >nul

@(
  echo Main-Class: com.hongguo.api.Main
  echo Implementation-Title: hongguo-api
  echo Implementation-Version: 1.0.0
) > "java\build\manifest.txt"

@if exist "java\dist\hongguo-api.jar" del "java\dist\hongguo-api.jar"

@pushd "java\build\classes"
@if errorlevel 1 goto :say_pushd_fail

@if exist "%JDK_BIN%jar.exe" (
  @"%JDK_BIN%jar.exe" --create --file "..\..\java\dist\hongguo-api.jar" --manifest "..\manifest.txt" .
) else (
  @jar --create --file "..\..\java\dist\hongguo-api.jar" --manifest "..\manifest.txt" .
)
@set "RC=%ERRORLEVEL%"
@popd

@if not "%RC%"=="0" goto :say_jar_fail

@for %%f in ("java\dist\hongguo-api.jar") do set "SIZE=%%~zf"
@set /a SIZE_KB=%SIZE% / 1024

@call :say build.done
@exit /b 0
