@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - stop

@rem ================================================================
@rem Pure ASCII on purpose: see the long note at the top of start.bat.
@rem
@rem Note the second trap documented there: "call :sub <arg>" inside an
@rem if (...) block loses the argument, so every message below is
@rem reached by "goto :say_xxx" instead.
@rem ================================================================

@cd /d "%~dp0.."
@set "CD=%CD%"

@call :say init
@goto :main

:say
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msg.ps1" -Key "%~1"
@exit /b %ERRORLEVEL%

:ports_busy
@call :say stop.port_busy
@set "HG_NETSTAT=%TEMP%\hongguo_netstat_%RANDOM%.txt"
@netstat -ano | findstr LISTENING | findstr /r /c:":%PORT% " /c:":%SIGN_PORT% " > "%HG_NETSTAT%"
@call :say stop.netstat
@del /q "%HG_NETSTAT%" >nul 2>&1
@set "HG_NETSTAT="
@goto :ports_done

:ports_free
@call :say stop.port_free

:ports_done
@call :say blank
@pause
@exit /b 0

:cfg_read
@rem Port detection follows server\config\config.json, so editing the
@rem config does not leave us probing a stale port.
@rem Two traps avoided here:
@rem  1) never put a multi-line for /f with backticks and a PowerShell
@rem     pipe inside an if (...) block -- cmd takes the pipe byte as the
@rem     end of the block and truncates it, leaving the ports empty.
@rem  2) never use "for /f ... do call :sub": a nested call whose
@rem     "goto :eof" returns only one level corrupts the call stack.
@if not defined PORT set "PORT=8000"
@if not defined SIGN_PORT set "SIGN_PORT=9099"
@set "HG_CFG_DUMP=%TEMP%\hongguo_stop_%RANDOM%.txt"
@powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $j = Get-Content -Raw 'server\config\config.json' | ConvertFrom-Json; 'PORT=' + $j.api.port; 'SIGN_PORT=' + $j.signer.port" > "%HG_CFG_DUMP%" 2>nul
@if exist "%HG_CFG_DUMP%" for /f "usebackq tokens=1,* delims==" %%A in ("%HG_CFG_DUMP%") do @set "%%A=%%B"
@del /q "%HG_CFG_DUMP%" >nul 2>&1
@set "HG_CFG_DUMP="
@if not defined PORT set "PORT=8000"
@if not defined SIGN_PORT set "SIGN_PORT=9099"
@exit /b 0

:main
@call :say stop.header

@rem -- Kill signer / API processes. PowerShell reports one line per
@rem    PID into a temp file and msg.ps1 renders it, so no CJK travels
@rem    on a command line.
@set "HG_STOPPED=%TEMP%\hongguo_stopped_%RANDOM%.txt"
@powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;" ^
  "$out=@();" ^
  "$t = Get-CimInstance Win32_Process | Where-Object { " ^
  "   ($_.Name -eq 'java.exe'  -and ($_.CommandLine -like '*unidbg-sign.jar*' -or $_.CommandLine -like '*hongguo-api.jar*')) -or " ^
  "   ($_.Name -eq 'node.exe'  -and ($_.CommandLine -like '*launcher.js*' -or $_.CommandLine -like '*server\src\server.js*')) " ^
  "};" ^
  "if ($t) { $out = @($t | ForEach-Object { $_.Name.Replace('.exe','') + ' ' + $_.ProcessId }) };" ^
  "if ($t) { $t | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } };" ^
  "[IO.File]::WriteAllLines($env:HG_STOPPED, $out, (New-Object Text.UTF8Encoding $false))"
@call :say stop.killed
@del /q "%HG_STOPPED%" >nul 2>&1
@set "HG_STOPPED="

@call :say stop.done

@call :cfg_read
@netstat -ano | findstr /r /c:":%PORT% " /c:":%SIGN_PORT% " | findstr "LISTENING" >nul 2>&1
@if errorlevel 1 goto :ports_free
@goto :ports_busy
