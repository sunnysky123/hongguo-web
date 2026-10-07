@echo off
@setlocal DisableDelayedExpansion
@title hongguo-web - install JRE

@rem ================================================================
@rem  Download and unpack a Temurin JRE into jre\. That is ALL this
@rem  script does.
@rem
@rem  Design rule: see the long note at the top of start.bat -- the
@rem  batch layer stays trivial and 100% ASCII.
@rem
@rem  It also uses no PowerShell. PowerShell was the previous home of
@rem  the Chinese message catalogue (msg.ps1, now deleted) and of the
@rem  download itself. Both are gone: this file must be able to run on
@rem  a machine where PowerShell is disabled by policy, since it is
@rem  the very script you reach for when Java is missing.
@rem
@rem  curl.exe and tar.exe both ship with Windows 10 1803 and later.
@rem  If either is absent we say so plainly rather than falling back
@rem  to a PowerShell path that may be blocked anyway.
@rem
@rem  Set HG_ASSUME_YES=1 to skip the confirmation prompt.
@rem ================================================================

@cd /d "%~dp0.."

set "JRE_DIR=%CD%\jre"
set "ZIP=%TEMP%\temurin-jre-25.zip"
@rem The adoptium endpoint answers with a redirect to the real file;
@rem -L follows it, -f fails on an HTTP error instead of writing the
@rem error page into the zip.
set "URL_TEMURIN=https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jre/hotspot/normal/eclipse"

@rem --- already have one? --------------------------------------------
@rem Nothing to do if either a bundled or a system runtime exists.
if exist "%JRE_DIR%\bin\java.exe" goto :have_bundled
where java.exe >nul 2>&1
if not errorlevel 1 goto :have_system

@rem --- check the tools we need --------------------------------------
where curl.exe >nul 2>&1
if errorlevel 1 goto :no_curl
where tar.exe >nul 2>&1
if errorlevel 1 goto :no_tar

@rem --- confirm -------------------------------------------------------
echo.
echo   No Java runtime found on this machine.
echo.
echo   About to download Temurin JRE 25 LTS for Windows x64 (~50 MB)
echo   from api.adoptium.net and unpack it into:
echo     %JRE_DIR%
echo.
if defined HG_ASSUME_YES goto :download
echo   Press Ctrl-C to cancel, or Enter to continue...
set /p "ANS="
if /i not "%ANS%"=="" goto :cancelled
goto :download

:download
echo.
echo   Downloading...
curl.exe -L -f --progress-bar -o "%ZIP%" "%URL_TEMURIN%"
if errorlevel 1 goto :download_failed

echo.
echo   Unpacking...
@rem --strip-components drops the single top-level directory that the
@rem Temurin zip always contains, so bin\ lands directly in jre\.
if exist "%JRE_DIR%" rmdir /s /q "%JRE_DIR%"
mkdir "%JRE_DIR%" 2>nul
tar.exe -xf "%ZIP%" -C "%JRE_DIR%" --strip-components 1
if errorlevel 1 goto :unpack_failed

if not exist "%JRE_DIR%\bin\java.exe" goto :unpack_failed
del /q "%ZIP%" >nul 2>&1

echo.
echo   Done. Java is ready at:
echo     %JRE_DIR%\bin\java.exe
echo.
pause
exit /b 0

:download_failed
echo.
echo   Download failed. The URL was:
echo     %URL_TEMURIN%
echo.
echo   If you are behind a proxy, download that file manually and unpack
echo   it into the jre\ folder (needs bin\java.exe inside).
echo.
pause
exit /b 1

:unpack_failed
echo.
echo   Unpacking failed -- the archive may be truncated.
echo   Unpack %ZIP% by hand into the jre\ folder, then retry.
echo.
pause
exit /b 1

:no_curl
echo.
echo   curl.exe not found, cannot download.
echo   Temurin JRE 25 for Windows x64 is at:
echo     https://adoptium.net/temurin/releases/?version=25
echo   Unpack it into the jre\ folder (needs bin\java.exe inside).
echo.
pause
exit /b 1

:no_tar
echo.
echo   tar.exe not found, cannot unpack the archive.
echo   Temurin JRE 25 for Windows x64 is at:
echo     https://adoptium.net/temurin/releases/?version=25
echo   Unpack it into the jre\ folder (needs bin\java.exe inside).
echo.
pause
exit /b 1

:have_bundled
echo.
echo   Already installed: %JRE_DIR%\bin\java.exe
echo   Nothing to do.
echo.
pause
exit /b 0

:have_system
echo.
echo   A Java runtime is already available on this machine, so nothing
echo   was downloaded.
echo   To force the bundled copy anyway, unpack Temurin 25 into jre\.
echo.
pause
exit /b 0

:cancelled
echo.
echo   Cancelled. Nothing was downloaded.
echo.
pause
exit /b 0
