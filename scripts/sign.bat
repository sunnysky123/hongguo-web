@echo off
@chcp 65001 >nul 2>&1
@setlocal DisableDelayedExpansion
@title unidbg 签名服务

@cd /d "%~dp0..\signer"

@rem签名端口跟随 server\config\config.json；命令行参数优先
@set SIGN_PORT=9099
@if exist "..\server\config\config.json" (
  @for /f "usebackq delims=" %%v in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "(Get-Content -Raw '..\server\config\config.json' | ConvertFrom-Json).signer.port"`) do @set SIGN_PORT=%%v
)
@if not "%~1"=="" set SIGN_PORT=%~1

echo.
echo   ==========================================
echo     unidbg 签名服务
echo   ==========================================
echo.

echo   提示：日常使用不必单独跑本脚本。
echo         直接双击 scripts\start.bat 会自动拉起签名服务并等待就绪。
echo         本脚本用于单独调试签名链路，或配合 --sign-only 模式使用。
echo.

@set JAVA_BIN=
@if exist "jre\bin\java.exe" (
  @set JAVA_BIN=%CD%\jre\bin\java.exe
  echo   [JRE] 使用项目自带运行时
  @goto :run
)

@where java >nul 2>&1
@if errorlevel 1 (
  echo   [错误] 未找到 Java 运行时
  echo.
  echo   请任选一种方式：
  echo     1) 把 Windows 版 JRE 解压到项目的 jre\ 目录
  echo     2) 安装 Temurin 25+ 并加入 PATH：https://adoptium.net/
  echo.
  echo   也可直接双击 scripts\install-jre.bat 自动下载安装。
  echo.
  @pause
  @exit /b 1
)

@for /f "delims=" %%j in ('where java') do (
  @if not defined JAVA_BIN set JAVA_BIN=%%j
)
echo   [JRE] 使用系统 Java：%JAVA_BIN%

:run
echo   [JAR] unidbg-sign.jar
echo   [端口] %SIGN_PORT%
echo.
echo   启动中（unidbg 初始化约需 10-30 秒）...
echo   停止服务：Ctrl-C 或另开窗口运行 scripts\stop.bat
echo.

@set JAVA_MAJOR=0
@for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /r "version \"[0-9]"') do @set "JAVA_MAJOR=%%~v"
@set "JAVA_MAJOR=%JAVA_MAJOR:v=%"
@if %JAVA_MAJOR% LSS 17 (
  echo   [错误] Java 版本过低：%JAVA_MAJOR%
  echo          签名服务需要 Java 17 或更高版本，推荐 Temurin 25 LTS。
  echo          请把 JRE 25 解压到 jre\ 覆盖旧目录后重试。
  @pause
  @exit /b 1
)

@set NATIVE_ACCESS=
@if %JAVA_MAJOR% GEQ 24 set NATIVE_ACCESS=--enable-native-access=ALL-UNNAMED

@rem 签名服务固定绑回环地址：它只供本机 API 调用。
@rem 必须显式覆盖，避免继承外界的 BIND_HOST（可能被设成主机名而解析不了）。
@set "BIND_HOST=127.0.0.1"

@java --add-opens java.base/java.lang=ALL-UNNAMED %NATIVE_ACCESS% -Xmx512m -cp unidbg-sign.jar com.hongguo.sign.FqTrace serve %SIGN_PORT%

echo.
echo   签名服务已退出。
@pause
