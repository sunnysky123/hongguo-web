@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion
title 安装 Node.js（LTS）

cd /d "%~dp0.."

set NODE_MIN_MAJOR=18
set URL_INDEX=https://nodejs.org/dist/index.json
set URL_MIRROR=https://npmmirror.com/mirrors/node

echo.
echo   ==========================================
echo     安装 Node.js（LTS 版本）
echo   ==========================================
echo.
echo   本项目需要 Node.js %NODE_MIN_MAJOR% 或更高版本。
echo.

REM ---------- 情况 1：已安装且版本足够新 ----------
where node >nul 2>&1
if not errorlevel 1 (
  set NODEV=
  for /f "delims=" %%v in ('node -v') do set NODEV=%%v
  echo   [检测到] 本机已安装 Node.js !NODEV!
  echo.
  node -e "var m=+process.versions.node.split('.')[0];process.exit(m<%NODE_MIN_MAJOR%?1:0)" >nul 2>&1
  if not errorlevel 1 (
    echo   [完成] 版本满足要求（>= %NODE_MIN_MAJOR%），无需安装。
    echo.
    echo   现在可以运行 scripts\start.bat 启动服务。
    echo.
    pause
    exit /b 0
  )
  echo   [注意] 版本低于 %NODE_MIN_MAJOR%，建议升级到 LTS 版本。
  echo.
)

REM ---------- 情况 2：查询最新 LTS 版本号 ----------
REM 用 for 循环遍历而非管道：管道符在 cmd 双引号内无需转义，
REM 写成 ^| 反而会把 ^ 原样传给 PowerShell 导致语法错误。
echo   正在查询最新 LTS 版本...
set LTS_VER=
for /f "usebackq delims=" %%v in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try {$j=Invoke-RestMethod -Uri '%URL_INDEX%' -UseBasicParsing; for($i=0;$i -lt $j.Count;$i++){if($j[$i].lts){Write-Output $j[$i].version; break}}} catch {}"`) do set LTS_VER=%%v

if not defined LTS_VER (
  echo   [错误] 无法获取版本信息，请检查网络。
  echo.
  echo   可手动打开 https://nodejs.org/zh-cn/download 下载
  echo   LTS 版本后手动安装。
  echo.
  pause
  exit /b 1
)

REM 去掉版本号前缀 v，得到纯数字版本号供后续拼接
set LTS_TAG=!LTS_VER:v=!
for /f "tokens=1 delims=." %%m in ("!LTS_TAG!") do set LTS_MAJOR=%%m
echo   最新 LTS：!LTS_VER!

REM ---------- 情况 3：架构检测 ----------
set ARCH=x64
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set ARCH=arm64
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set ARCH=arm64
echo   系统架构：%PROCESSOR_ARCHITECTURE%（使用 %ARCH% 包）
echo.

set FILE_NAME=node-!LTS_VER!-!ARCH!.msi
set URL_MAIN=https://nodejs.org/dist/!LTS_VER!/!FILE_NAME!
set URL_BACKUP=%URL_MIRROR%/!LTS_VER!/!FILE_NAME!

echo   即将下载并安装 Node.js LTS（!LTS_VER!，约 30-35MB）
echo   下载地址：
echo     %URL_MAIN%
echo.
REM HG_ASSUME_YES=1 时跳过确认（由 start.bat 自动调用时设置，
REM 避免同一个问题连问两遍）
if /i "%HG_ASSUME_YES%"=="1" goto :do_install
set /p ANS="   是否继续？(Y/N) "
if /i not "%ANS%"=="Y" (
  echo   已取消。
  pause
  exit /b 0
)

:do_install
REM ---------- 下载并静默安装 ----------
echo.
echo   正在下载并安装，请稍候...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" ^
  "$ProgressPreference='SilentlyContinue';" ^
  "$msi=Join-Path $env:TEMP 'node-lts.msi';" ^
  "$urls=@('%URL_MAIN%','%URL_BACKUP%');" ^
  "$ok=$false;" ^
  "foreach($u in $urls){" ^
  "  try {" ^
  "    Write-Host ('   正在下载：' + $u);" ^
  "    Invoke-WebRequest -Uri $u -OutFile $msi -UseBasicParsing;" ^
  "    if((Get-Item $msi).Length -lt 1MB){throw '下载内容异常（文件过小）'};" ^
  "    $ok=$true; break" ^
  "  } catch { Write-Host ('   该源失败：' + $_.Exception.Message) -ForegroundColor Yellow }" ^
  "}" ^
  "if(-not $ok){throw '所有下载源均失败'};" ^
  "Write-Host '   下载完成，正在安装（静默模式）...';" ^
  "$p=Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i',$msi,'/qn','/norestart') -Wait -PassThru;" ^
  "Remove-Item $msi -Force -ErrorAction SilentlyContinue;" ^
  "if($p.ExitCode -ne 0){throw ('安装程序返回码 ' + $p.ExitCode)}"

echo.
if errorlevel 1 (
  echo   [错误] 安装失败。可手动下载后双击安装：
  echo     %URL_MAIN%
  echo.
  echo   安装时请保持默认选项即可。
  echo.
  pause
  exit /b 1
)

REM ---------- 安装后校验 ----------
REM 新装的 node.exe 尚未进入当前进程的 PATH，需从标准安装目录查找。
REM 注意：ProgramFiles(x86) 里的括号会被 cmd 当作块语法，
REM 故这里用延迟展开逐段拼接，避开转义歧义。
set NODE_EXE=
set PF32=%ProgramFiles%
if not defined PF32 set PF32=%ProgramFiles^%(x86^)^%
if exist "!PF32!\nodejs\node.exe" set NODE_EXE=!PF32!\nodejs\node.exe
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set NODE_EXE=%ProgramFiles%\nodejs\node.exe
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe

if not defined NODE_EXE (
  echo   [警告] 未在默认目录找到 node.exe。
  echo.
  echo   请重新打开命令行窗口以刷新 PATH，然后验证：
  echo     node -v
  echo.
  echo   若仍提示不是内部命令，可手动将 Node.js 安装目录
  echo   （通常是 C:\Program Files\nodejs）加入系统 PATH。
  echo.
  pause
  exit /b 0
)

for /f "delims=" %%v in ('"!NODE_EXE!" -v') do set NODEV=%%v
echo   [完成] Node.js !NODEV! 安装成功：!NODE_EXE!
echo.
echo   现在可以运行 scripts\start.bat 启动服务。
echo.
pause
