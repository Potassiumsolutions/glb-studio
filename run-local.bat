@echo off
REM ── KSOL Designs GLB Studio — run locally ─────────────────────────
REM Serves this folder on one local port so all tools share one origin
REM (that's what lets them share the Studio Library).
cd /d "%~dp0"
set PORT=8770
echo Opening KSOL Designs GLB Studio at http://localhost:%PORT%/studio/  ...
start "" "http://localhost:%PORT%/studio/index.html"
python -m http.server %PORT%
REM If Python isn't found, install it from python.org.
