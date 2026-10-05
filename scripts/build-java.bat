@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion
title 构建 hongguo-api.jar

cd /d "%~dp0.."

echo.
echo   ============================================
echo     构建 hongguo-api.jar
echo   ============================================
echo.

REM ---------- 探测 JDK 17+ ----------
set JAVAC_BIN=
if exist "signer\jre\bin\javac.exe" (
  set JAVAC_BIN=%CD%\signer\jre\bin\javac.exe
  echo   [JDK] 项目自带 JRE
  goto :compile
)

REM 解压多一层的情况（signer\jre\jdk-25.x\bin\javac.exe，Temurin zip 常见）
for /d %%d in ("signer\jre\*") do (
  if not defined JAVAC_BIN if exist "%%~fd\bin\javac.exe" (
    set "JAVAC_BIN=%%~fd\bin\javac.exe"
    echo   [JDK] 项目自带 JRE（解压多一层）
    goto :compile
  )
)

if defined JAVA_HOME (
  if exist "%JAVA_HOME%\bin\javac.exe" (
    set JAVAC_BIN=%JAVA_HOME%\bin\javac.exe
    echo   [JDK] JAVA_HOME
    goto :compile
  )
)

where javac >nul 2>&1
if not errorlevel 1 (
  set JAVAC_BIN=javac
  echo   [JDK] 系统 PATH
  goto :compile
)

echo   [错误] 未找到 javac，请安装 JDK 17 或更高版本
echo          推荐 Temurin 17+：https://adoptium.net/
echo.
pause
exit /b 1

:compile
"%JAVAC_BIN%" -version 2>&1 | findstr /r "javac" >nul 2>&1

REM ---------- 编译 ----------
echo   [1/2] 编译源码 ...
if exist "java\build" rmdir /s /q "java\build"
mkdir "java\build\classes" 2>nul
mkdir "java\dist" 2>nul

REM 源文件列表（逐个追加，避开 for 的空行与 delims 陷阱）
if exist "java\build\sources.txt" del "java\build\sources.txt"
for /r "java\src" %%f in (*.java) do echo %%f>> "java\build\sources.txt"

if not exist "java\build\sources.txt" (
  echo   [错误] 未找到源文件，请确认 java\src 目录完整
  pause
  exit /b 1
)

for /f %%c in ('find /v /c "" ^< "java\build\sources.txt"') do set CNT=%%c
echo         源文件 !CNT! 个

"%JAVAC_BIN%" -encoding UTF-8 -d "java\build\classes" @"java\build\sources.txt"
if errorlevel 1 (
  echo.
  echo   [错误] 编译失败，请查看上方报错
  pause
  exit /b 1
)

REM ---------- 打包 ----------
echo   [2/2] 打包 JAR ...
if exist "java\resources" xcopy /e /i /q /y "java\resources" "java\build\classes\" >nul

(
  echo Main-Class: com.hongguo.api.Main
  echo Implementation-Title: hongguo-api
  echo Implementation-Version: 1.0.0
) > "java\build\manifest.txt"

if exist "java\dist\hongguo-api.jar" del "java\dist\hongguo-api.jar"

pushd "java\build\classes"
jar --create --file "..\..\java\dist\hongguo-api.jar" --manifest "..\manifest.txt" .
set RC=%ERRORLEVEL%
popd

if not "%RC%"=="0" (
  echo.
  echo   [错误] 打包失败，请确认 jar 命令可用（JDK 9+）
  pause
  exit /b 1
)

for %%f in ("java\dist\hongguo-api.jar") do set SIZE=%%~zf
set /a SIZE_KB=%SIZE% / 1024

echo.
echo   构建完成：java\dist\hongguo-api.jar (!SIZE_KB! KB)
echo.
echo   启动：scripts\start.bat
echo.

exit /b 0
