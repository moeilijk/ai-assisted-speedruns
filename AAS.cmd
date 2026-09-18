@echo off
rem Double-click to open the AAS GUI. The harness runs in WSL (see docs/install.md); this starts it there from the
rem folder this file is in and opens the page in your browser. Close this window to end the GUI.
setlocal
set "HERE=%~dp0"
rem %~dp0 ends with a backslash, which would escape the closing quote for wsl.exe.
set "HERE=%HERE:~0,-1%"
rem A drive letter that stands for a WSL share (Y: for \\wsl.localhost\Ubuntu) is a path wsl.exe cannot translate
rem ("Failed to translate"), and it then starts in the home folder instead. The share itself it does translate.
if "%HERE:~1,1%"==":" call :share "%HERE:~0,2%"
wsl.exe --cd "%HERE%" -- bash -lic "[ -f packages/core/src/cli.mjs ] || { echo 'AAS.cmd is not in the repository folder; WSL is in' \"$PWD\" '- put AAS.cmd in the ai-assisted-speedruns folder.'; exit 1; }; node packages/core/src/cli.mjs gui"
if errorlevel 1 (
  echo.
  echo The GUI did not start; the reason is in the lines above. If it says that node was not found,
  echo it needs WSL with Node 22 or newer: see docs\install.md.
  pause
)
exit /b

rem Replaces the drive letter in HERE by the share it is mapped to, if it is mapped to one.
:share
for /f "tokens=2,*" %%A in ('net use %~1 2^>nul ^| findstr /c:"\\"') do if "%%B"=="" (set "REMOTE=%%A") else (set "REMOTE=%%B")
if not defined REMOTE exit /b
if not "%REMOTE:~0,2%"=="\\" exit /b
set "HERE=%REMOTE%%HERE:~2%"
exit /b
