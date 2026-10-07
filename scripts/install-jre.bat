@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - install JRE

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

@set JRE_DIR=%CD%\jre
@set URL_TEMURIN=https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jre/hotspot/normal/eclipse

@call :say init
@goto :main

:say
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg.ps1" -Key "%~1"
@exit /b %ERRORLEVEL%

:say_have_bundled
@call :say jre.have_bundled
@pause
@exit /b 0

:say_have_system
@call :say jre.have_system
@pause
@exit /b 0

:say_cancelled
@call :say jre.cancelled
@pause
@exit /b 0

:say_failed
@call :say jre.fail
@pause
@exit /b 1

:ask
@call :say jre.need_download
@if defined HG_ASSUME_YES goto :download
@call :say jre.prompt
@set /p "ANS="
@if /i "%ANS%"=="Y" goto :download
@goto :say_cancelled

:download
@call :say jre.downloading
@powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" ^
  "$ProgressPreference='SilentlyContinue';" ^
  "$dst='%JRE_DIR%';" ^
  "try {" ^
  "  New-Item -ItemType Directory -Force -Path $dst | Out-Null;" ^
  "  Invoke-WebRequest -Uri '%URL_TEMURIN%' -OutFile \"$env:TEMP\temurin25-jre.zip\" -UseBasicParsing;" ^
  "  & '%~dp0msg.ps1' -Key jre.extracting;" ^
  "  Expand-Archive -Path \"$env:TEMP\temurin25-jre.zip\" -DestinationPath \"$env:TEMP\temurin-extract\" -Force;" ^
  "  $inner = Get-ChildItem \"$env:TEMP\temurin-extract\" -Directory | Select-Object -First 1;" ^
  "  Copy-Item -Path (Join-Path $inner.FullName '*') -DestinationPath $dst -Recurse -Force;" ^
  "  Remove-Item \"$env:TEMP\temurin-extract\" -Recurse -Force;" ^
  "  Remove-Item \"$env:TEMP\temurin25-jre.zip\" -Force;" ^
  "  if (Test-Path \"$dst\bin\java.exe\") {" ^
  "    & '%~dp0msg.ps1' -Key jre.ok" ^
  "  } else { & '%~dp0msg.ps1' -Key jre.unpack_fail; exit 1 }" ^
  "} catch { [Console]::Error.WriteLine('   [error] ' + $_.Exception.Message); exit 1 }"
@if errorlevel 1 goto :say_failed

@call :say jre.done
@pause
@exit /b 0

:main
@call :say jre.banner
@if exist "%JRE_DIR%\bin\java.exe" goto :say_have_bundled
@where java >nul 2>&1
@if not errorlevel 1 goto :say_have_system
@goto :ask
