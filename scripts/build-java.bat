@echo off
@chcp 65001 >nul 2>&1
@setlocal DisableDelayedExpansion
@title 构建 hongguo-api.jar

@cd /d "%~dp0.."
@if not exist "java\src\com\hongguo\api\Main.java" (
  echo   [错误] 定位不到项目根目录（java\src 不存在）。
  echo          当前目录：%CD%
  echo          请通过 scripts\build-java.bat 或 scripts\start.bat 运行，
  echo          不要单独复制本脚本到其他位置执行。
  echo.
  @pause
  @exit /b 1
)

echo.
echo   ============================================
echo     构建 hongguo-api.jar
echo   ============================================
echo.

@set "JAVAC_BIN="
@set "JDK_BIN="

@if exist "jre\bin\javac.exe" (
  @set "JAVAC_BIN=%CD%\jre\bin\javac.exe"
  @set "JDK_BIN=%CD%\jre\bin\"
  echo   [JDK] 项目自带 jre
  @goto :compile
)

@for /d %%d in ("jre\*") do (
  @if not defined JAVAC_BIN if exist "%%~fd\bin\javac.exe" (
    @set "JAVAC_BIN=%%~fd\bin\javac.exe"
    @set "JDK_BIN=%%~fd\bin\"
    echo   [JDK] 项目自带 jre（解压多一层）
    @goto :compile
  )
)

@if defined JAVA_HOME (
  @if exist "%JAVA_HOME%\bin\javac.exe" (
    @set "JAVAC_BIN=%JAVA_HOME%\bin\javac.exe"
    @set "JDK_BIN=%JAVA_HOME%\bin\"
    echo   [JDK] JAVA_HOME
    @goto :compile
  )
)

@where javac >nul 2>&1
@if errorlevel 1 goto :no_jdk

@for %%i in (javac.exe) do set "JDK_BIN=%%~dp$PATH:i"
@set "JAVAC_BIN=%JDK_BIN%javac.exe"
echo   [JDK] 系统 PATH
@goto :compile

:no_jdk
echo   [错误] 未找到 javac，本机无法编译 Java 源码。
echo          说明：发行包已内置 java\dist\hongguo-api.jar，
echo          正常启动不会走到这里 —— 仅在 JAR 缺失（被删除或自行修改
echo          源码）时才需要编译，此时请安装 JDK 17+：
echo          https://adoptium.net/temurin/releases/?version=17
echo          （下载 .msi 安装即可，默认选项会自动配置 JAVA_HOME）
echo          或把包含 javac.exe 的完整 JDK 放入 jre\ 目录。
echo.
@pause
@exit /b 1

:compile
@"%JAVAC_BIN%" -version 2>&1 | findstr /r "javac" >nul 2>&1
@if errorlevel 1 (
  echo   [警告] 无法读取 javac 版本（可能版本过旧或已损坏）：%JAVAC_BIN%
)

echo   [1/2] 编译源码 ...
@if exist "java\build" rmdir /s /q "java\build"
@mkdir "java\build\classes" 2>nul
@if not exist "java\build\classes" (
  echo.
  echo   [错误] 无法创建 java\build\classes 目录。
  echo          当前目录：%CD%
  echo          常见原因：目录被其他程序占用（资源管理器/杀毒软件），
  echo                    或磁盘权限不足。请关闭占用后重试。
  echo.
  @pause
  @exit /b 1
)
@mkdir "java\dist" 2>nul
@if not exist "java\dist" (
  echo   [错误] 无法创建 java\dist 目录，请检查权限后重试。
  echo.
  @pause
  @exit /b 1
)

@if exist "java\build\sources.txt" del "java\build\sources.txt"
@for /r "java\src" %%f in (*.java) do >>"java\build\sources.txt" echo %%f

@if not exist "java\build\sources.txt" (
  echo   [错误] 未找到源文件，请确认 java\src 目录完整
  @pause
  @exit /b 1
)

@for /f %%c in ('find /v /c "" ^< "java\build\sources.txt"') do set CNT=%%c
echo         源文件 %CNT% 个

@"%JAVAC_BIN%" -encoding UTF-8 -d "java\build\classes" @"java\build\sources.txt"
@if errorlevel 1 (
  echo.
  echo   [错误] 编译失败，请查看上方报错
  @pause
  @exit /b 1
)

echo   [2/2] 打包 JAR ...
@if exist "java\resources" xcopy /e /i /q /y "java\resources" "java\build\classes\" >nul

@(
  echo Main-Class: com.hongguo.api.Main
  echo Implementation-Title: hongguo-api
  echo Implementation-Version: 1.0.0
) > "java\build\manifest.txt"

@if exist "java\dist\hongguo-api.jar" del "java\dist\hongguo-api.jar"

@pushd "java\build\classes"
@if errorlevel 1 (
  echo   [错误] 无法进入 java\build\classes（系统找不到指定的路径）。
  echo          当前目录：%CD%
  echo          请关闭占用该目录的程序后重试。
  echo.
  @pause
  @exit /b 1
)

@if exist "%JDK_BIN%jar.exe" (
  @"%JDK_BIN%jar.exe" --create --file "..\..\java\dist\hongguo-api.jar" --manifest "..\manifest.txt" .
) else (
  @jar --create --file "..\..\java\dist\hongguo-api.jar" --manifest "..\manifest.txt" .
)
@set RC=%ERRORLEVEL%
@popd

@if not "%RC%"=="0" (
  echo.
  echo   [错误] 打包失败（jar 退出码 %RC%）。
  echo          使用的 JDK bin：%JDK_BIN%
  echo          请确认该目录下 jar.exe 存在且为 JDK 9+。
  @pause
  @exit /b 1
)

@for %%f in ("java\dist\hongguo-api.jar") do set SIZE=%%~zf
@set /a SIZE_KB=%SIZE% / 1024

echo.
echo   构建完成：java\dist\hongguo-api.jar (%SIZE_KB% KB)
echo.
echo   启动：scripts\start.bat
echo.

@exit /b 0
