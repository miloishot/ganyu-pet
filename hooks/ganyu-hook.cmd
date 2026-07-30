@echo off
rem ganyu-pet hook forwarder.
rem   ganyu-hook.cmd <source> [port]        source = codex | claude
rem Reads the agent's hook JSON from stdin and POSTs it to the local pet server.
rem Contract: ALWAYS exit 0, never block the agent, always drain stdin.
setlocal

set "GANYU_SRC=%~1"
if not defined GANYU_SRC set "GANYU_SRC=codex"

set "GANYU_HOOK_PORT=%~2"
if not defined GANYU_HOOK_PORT if defined GANYU_PORT set "GANYU_HOOK_PORT=%GANYU_PORT%"
if not defined GANYU_HOOK_PORT set "GANYU_HOOK_PORT=47821"

if not exist "%SystemRoot%\System32\curl.exe" goto :ganyu_drain_stdin

"%SystemRoot%\System32\curl.exe" -sS -X POST "http://127.0.0.1:%GANYU_HOOK_PORT%/event/%GANYU_SRC%" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/json" --data-binary @- >nul 2>&1
if errorlevel 1 goto :ganyu_drain_stdin
exit /b 0

:ganyu_drain_stdin
rem No curl, or curl bailed before consuming stdin: swallow the payload so the
rem agent's write end never blocks on a full pipe.
"%SystemRoot%\System32\more.com" >nul 2>nul
exit /b 0
