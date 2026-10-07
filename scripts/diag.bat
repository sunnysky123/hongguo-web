@echo off
REM ===================================================================
REM diag.bat - diagnose the cmd console environment.
REM
REM Run it the SAME way you run start.bat (double-click), then paste
REM the whole output back. It prints the facts that decide whether the
REM garbled / doubled Chinese comes from this repo or from the console.
REM
REM Every line here is pure ASCII ON PURPOSE. If this file contained
REM Chinese it could not diagnose the very problem it is meant for.
REM ===================================================================
@setlocal DisableDelayedExpansion

echo === 1. OS / cmd version ===
@ver
@echo.

echo === 2. Console code page as inherited ===
@chcp
@echo.

echo === 3. QuickEditMode (1 = ON: text can be selected, and selected text runs on Enter) ===
@reg query "HKCU\Console" /v QuickEditMode 2>nul
@echo   (a missing value means QuickEdit is ON by default)
@echo.

echo === 4. File encoding of start.bat ===
@powershell -NoProfile -Command ^
  "$b=[IO.File]::ReadAllBytes('%~dp0start.bat');" ^
  "Write-Host ('   size          = ' + $b.Length + ' bytes');" ^
  "Write-Host ('   first 3 bytes = ' + (($b[0..2] | ForEach-Object { '{0:X2}' -f $_ }) -join ' '));" ^
  "Write-Host ('   UTF-8 BOM     = ' + (($b[0] -eq 0xEF) -and ($b[1] -eq 0xBB) -and ($b[2] -eq 0xBF)))"
@echo.

echo === 5. chcp 65001, then the code page again ===
@chcp 65001
@echo.

echo === 6. CONTROLLED TEST: the same Chinese, two output paths ===
@echo   6a. printed by cmd echo, from UTF-8 bytes living in THIS file:
@echo   6b. printed by PowerShell, built from [char] code points, so no
@echo       UTF-8 bytes are involved on the cmd side at all:
@powershell -NoProfile -Command ^
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" ^
  "Write-Host ('      ' + [char]0x6B63 + [char]0x5728 + [char]0x542F + [char]0x52A8)"
@echo   6c. repeat both, to show whether anything shows up twice:
@echo   6d. a short Chinese line:
@echo   短
@echo   6e. a longer Chinese line:
@echo   启动器日志
@echo.

echo === 7. Same test, but AFTER a few filler lines ===
@echo   The filler shifts every later line by a few bytes. If the Chinese
@echo   below renders differently from 6d/6e, the cause is byte-offset
@echo   dependent, which points at how cmd buffers the file.
@rem filler
@rem filler
@rem filler
@rem filler
@rem filler
@rem filler
@rem filler
@rem filler
@echo   7a. 启动器日志
@rem filler
@rem filler
@rem filler
@rem filler
@echo   7b. 启动器日志
@echo.

echo === 8. Questions to answer when you paste the output back ===
@echo   Q1  In 6a, did the Chinese print correctly?
@echo   Q2  In 6b, did the PowerShell Chinese print correctly?
@echo   Q3  Was anything printed TWICE (every glyph doubled), or once?
@echo   Q4  Does 7a/7b render the same as 6e?
@echo   Q5  Have you ever dragged to select text in this console window and
@echo       then pressed Enter? Doing that RUNS the selection as commands,
@echo       which looks exactly like "prompt + echo. + doubled text".
@echo.

pause
endlocal