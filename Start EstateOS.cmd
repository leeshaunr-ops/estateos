@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% equ 0 (
  node server.mjs
) else (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.mjs
  ) else (
    echo Node.js 24 or later is needed to run EstateOS.
  )
)
pause
