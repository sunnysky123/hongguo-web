@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion
title 安装 Java 运行时（签名服务依赖）

cd /d "%~dp0.."

set JRE_DIR=%CD%\jre
set URL_TEMURIN=https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jre/hotspot/normal/eclipse

echo.
echo   ==========================================
echo     安装 Java 运行时
echo   ==========================================
echo.
echo   签名服务需要 Java 17 或更高版本（推荐 25 LTS）。
echo.

if exist "%JRE_DIR%\bin\java.exe" (
  echo   [完成] 项目已自带 Java 运行时：
  echo          jre\
  for /f "tokens=3 delims==" %%v in ('findstr "JAVA_VERSION=" "%JRE_DIR%\release"') do echo          版本 %%v
  echo.
  echo   无需安装，可直接运行 scripts\start.bat
  echo.
  pause
  exit /b 0
)

where java >nul 2>&1
if not errorlevel 1 (
  echo   [检测到] 系统已安装 Java：
  for /f "delims=" %%j in ('where java') do echo          %%j
  java -version 2>&1 | findstr /r /c:"version"
  echo.
  echo   [完成] 无需安装，可直接运行 scripts\start.bat
  echo.
  pause
  exit /b 0
)

echo   [未检测到] 本机没有 Java 运行时。
echo.
echo   即将从 Adoptium 官方源下载 Temurin JRE 25 LTS（Windows x64，约 56MB）
echo   下载地址：
echo     %URL_TEMURIN%
echo.
set /p ANS="   是否继续？(Y/N) "
if /i not "%ANS%"=="Y" (
  echo   已取消。
  pause
  exit /b 0
)

echo.
echo   正在下载...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" ^
  "$ProgressPreference='SilentlyContinue';" ^
  "try {" ^
  "  New-Item -ItemType Directory -Force -Path '%JRE_DIR%' | Out-Null;" ^
  "  Write-Host '   正在下载（约 56MB）...';" ^
  "  Invoke-WebRequest -Uri '%URL_TEMURIN%' -OutFile \"$env:TEMP\temurin25-jre.zip\" -UseBasicParsing;" ^
  "  Write-Host '   下载完成，正在解压...';" ^
  "  Expand-Archive -Path \"$env:TEMP\temurin25-jre.zip\" -DestinationPath \"$env:TEMP\temurin-extract\" -Force;" ^
  "  $inner = Get-ChildItem \"$env:TEMP\temurin-extract\" -Directory | Select-Object -First 1;" ^
  "  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination '%JRE_DIR%' -Recurse -Force;" ^
  "  Remove-Item \"$env:TEMP\temurin-extract\" -Recurse -Force;" ^
  "  Remove-Item \"$env:TEMP\temurin25-jre.zip\" -Force;" ^
  "  if (Test-Path '%JRE_DIR%\bin\java.exe') {" ^
  "    Write-Host '   [完成] Java 运行时已安装到 jre\' -ForegroundColor Green" ^
  "  } else { Write-Host '   [错误] 解压后未找到 java.exe' -ForegroundColor Red; exit 1 }" ^
  "} catch { Write-Host ('   [错误] ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"

echo.
if errorlevel 1 (
  echo   安装失败。可手动下载后解压到 jre\：
  echo     https://adoptium.net/temurin/releases/?version=25
  echo.
  pause
  exit /b 1
)

echo   现在可以运行 scripts\start.bat 启动服务。
echo.
pause
