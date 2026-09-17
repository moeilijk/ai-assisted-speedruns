@echo off
rem Double-click to open the AAS GUI. The harness runs in WSL (see docs/install.md); this starts it there from the
rem folder this file is in and opens the page in your browser. Close this window to end the GUI.
setlocal
set "HERE=%~dp0"
rem %~dp0 ends with a backslash, which would escape the closing quote for wsl.exe.
set "HERE=%HERE:~0,-1%"
wsl.exe --cd "%HERE%" -- bash -lic "node packages/core/src/cli.mjs gui"
if errorlevel 1 (
  echo.
  echo The GUI did not start. It needs WSL with Node 22 or newer: see docs\install.md.
  pause
)
