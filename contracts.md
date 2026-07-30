# ganyu-pet — Contracts & Spec

Desktop pet overlay: Ganyu (from the installed Codex pet `ganyu--chenxin-dlut`) lives on the Windows desktop, reacts to codex CLI **and** Claude Code lifecycle-hook events, chats in character via Haiku, and wanders the bottom edge of the screen when everything is idle.

This file is the single source of truth for parallel builders. **Own only your files. Interfaces here are binding.**

## Goal / success criteria (the verifier's checklist)

1. `npm test` (runs `node --test test/`) — all unit tests pass.
2. `npm run smoke` — Electron launches, creates a frameless transparent always-on-top window, prints `SMOKE_OK {json flags}` and exits 0 within 20s (env `GANYU_SMOKE=1` makes the app self-quit after ~5s).
3. Server + state standalone (`node src/main/server.mjs --standalone --port 47899`): POST a codex-shaped `PreToolUse` payload → `GET /state` reports `busy`; `PermissionRequest` → `waiting`; `Stop` → `idle` with a transient `celebrate` flag; a payload containing an error marker → `failed`.
4. `echo <sample JSON> | cmd /c hooks\ganyu-hook.cmd codex 47899` delivers the payload to a listening server (test with a throwaway node listener).
5. `node hooks/install-hooks.mjs` (dry-run, default) against **fixture copies** of `hooks.json` / `settings.json` produces valid JSON that preserves every pre-existing hook entry and adds ours exactly once (idempotent on re-run). It must never touch real config without `--apply`.
6. Speech unit tests: prompt template correct, 45s global cooldown enforced (15s floor for `waiting`/`failed` interrupts), canned fallback used when the CLI call fails. Live Haiku call is exercised once by the integrator (`claude -p --model haiku`); if offline, flag it — don't fail the build.
7. Wander scheduler unit tests with an injected clock: engages only after ≥90s aggregate idle, picks targets inside the primary display work area, cancels immediately on any state change.
8. Server binds `127.0.0.1` only. No secrets, no telemetry, nothing written outside the repo (except the installer with explicit `--apply`).

## Machine facts (Windows 11)

- Repo: `C:\Users\kw11l\Desktop\ganyu-pet` (`~/Desktop/ganyu-pet` in Git Bash).
- `node` 22 (`~/tools/nodejs`), `npm` available. **Use npm, not bun** (Electron's postinstall must run). Tests: built-in `node --test` — **no test framework deps**.
- `claude` CLI 2.1.220 at `~/.local/bin/claude` (`C:\Users\kw11l\.local\bin\claude`). No `ANTHROPIC_API_KEY` on this machine — speech goes through the CLI.
- Spritesheet (do **not** copy into the repo — load from disk):
  `C:\Users\kw11l\.codex\pets\ganyu--chenxin-dlut\spritesheet.webp` (fallback: read `spritesheetPath` from `pet.json` next to it; if `CODEX_HOME` env is set, use `$CODEX_HOME/pets/...`).
- No `jq`, no docker. Shell scripts must be `.cmd` or node — hook commands are invoked by codex/Claude on Windows.

## Repo layout & file ownership

| Module | Owner | Files |
|---|---|---|
| A electron-main | builder-A | `src/main/index.mjs`, `src/main/window.mjs`, `src/main/preload.cjs` |
| B server+state | builder-B | `src/main/server.mjs`, `src/main/state.mjs`, `test/state.test.mjs`, `test/server.test.mjs` |
| C renderer | builder-C | `src/renderer/index.html`, `src/renderer/pet.mjs`, `src/renderer/bubbles.mjs`, `src/renderer/styles.css` |
| D speech | builder-D | `src/main/speech.mjs`, `src/main/persona.mjs`, `test/speech.test.mjs` |
| E wander | builder-E | `src/main/wander.mjs`, `test/wander.test.mjs` |
| F hooks | builder-F | `hooks/ganyu-hook.cmd`, `hooks/install-hooks.mjs`, `test/install-hooks.test.mjs`, `hooks/fixtures/*` |
| integrator | integrator | `package.json`, `scripts/smoke.mjs`, plus minimal cross-module wiring fixes |

ESM everywhere (`"type": "module"`); the preload is CommonJS (`.cjs`) because Electron preloads with contextIsolation are CJS.

## Runtime architecture

Electron main process runs: HTTP hook server (module B) → state aggregator (B) → pushes to renderer via IPC (A) → renderer animates sprite + bubbles (C). Speech (D) and wander (E) are main-process modules driven by state transitions, with injected dependencies so they unit-test without Electron.

### HTTP contract (module B)

- `POST /event/:source` where `:source` ∈ `codex|claude`. Body: the raw hook JSON (may arrive URL-encoded as `payload=<json>` form data — accept both raw JSON body and `application/x-www-form-urlencoded` with a `payload` field, mirroring how Orca's hook forwards stdin).
- `GET /state` → `{ mode, sessionCount, sessions: [{id, source, mode, lastSeen}], celebrate: bool, wandering: bool }`.
- `GET /healthz` → 200 `ok`.
- Port **47821** (env `GANYU_PORT` overrides). Bind `127.0.0.1` only. If the port is taken: log a clear error and exit 1 (hook scripts hardcode the port).
- Server must be constructable standalone (`node src/main/server.mjs --standalone [--port N]`) with no Electron import.

### Event normalization & state machine (module B)

Payloads differ between codex and Claude Code — normalize defensively:

- `sessionId`: `payload.session_id ?? payload.thread_id ?? payload.sessionId ?? "<source>-unknown"`.
- `event`: `payload.hook_event_name ?? payload.event ?? payload.type ?? ":source-path-hint"` (the hook script also passes the event name when it can't be parsed; unknown events → activity ping only).
- Claude Code sample (real shape): `{"session_id":"abc","transcript_path":"...","cwd":"C:\\...","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{...}}`. Codex payloads: assume similar keys, parse tolerantly, keep the raw payload in a debug ring buffer (last 50, exposed at `GET /debug/events`, loopback only).

Per-session mode from last event:
`PreToolUse|PostToolUse|UserPromptSubmit|SubagentStart|SubagentStop|SessionStart` → `busy` · `PermissionRequest` (codex) / `Notification` (Claude, permission-flavored) → `waiting` · `Stop|SessionEnd` → `idle` (Stop also sets `celebrate` for 10s) · payload with `error|failed` markers (case-insensitive scan of tool_response/last message) → `failed` (sticky 30s, then falls back to the underlying mode).

Aggregate mode = highest priority across live sessions: `failed > waiting > busy > idle`. Sessions expire after 10 min without events (sweep every 30s). `celebrate` is a transient flag alongside the mode, not a mode.

State module exposes `createState({clock})` returning `{ingest(source, payload), aggregate(), onChange(cb)}` — injectable clock (`clock.now()`) for tests; production passes `() => Date.now()`.

### IPC contract (A ↔ C, via preload `window.ganyu`)

Preload exposes exactly:
- `ganyu.onState(cb)` — cb receives `{mode, sessionCount, celebrate, walk: {dir: 'left'|'right'} | null}`.
- `ganyu.onSpeak(cb)` — cb receives `{text}`.
- `ganyu.setInteractive(bool)` — toggles `setIgnoreMouseEvents(!bool, {forward: true})`.
- `ganyu.menuAction(action)` — `'toggle-mute' | 'toggle-pin' | 'quit'`.
- `ganyu.getFlags()` → Promise of `{muted, pinned, spritePath}` (spritePath as `file://` URL for the `<img>`/canvas source).

Channels (main side): `ganyu:state`, `ganyu:speak`, `ganyu:set-interactive`, `ganyu:menu`, `ganyu:get-flags`. Nothing else.

### Window (module A)

Frameless, transparent, `alwaysOnTop: 'screen-saver'`, `skipTaskbar`, not resizable, ~256×320 (192×208 sprite + bubble headroom), initial position bottom-right of primary display `workArea`, `webPreferences: {contextIsolation: true, preload: preload.cjs}`. Default click-through ON via `setIgnoreMouseEvents(true, {forward: true})`; renderer flips interactivity on sprite hover (see C). `GANYU_SMOKE=1` → after ~5s print `SMOKE_OK ` + JSON `{transparent, alwaysOnTop, frame:false}` to stdout and `app.quit()`. Single-instance lock. Wires modules together: server → state → (renderer push, speech, wander).

### Renderer (module C)

Canvas-based sprite engine. Spritesheet grid — 8 columns × 9 rows, frame 192×208, row map:

| Row | Animation |
|---|---|
| 0 idle · 1 run-right · 2 run-left · 3 waving · 4 jumping · 5 failed · 6 waiting · 7 busy (non-directional) · 8 review |

Mode → row: `idle→0`, `busy→7`, `waiting→6`, `failed→5`, `celebrate` pulse → 4 (jump) then 3 (wave) once, `walk.dir right→1 / left→2`. 8 fps default, 6 fps for walk rows. Loop all 8 frames per row. Chromium decodes `.webp` natively — draw via offscreen `<img>` → `drawImage` crops.

Hover behavior: `mouseenter` on the sprite's bounding box → `ganyu.setInteractive(true)`; `mouseleave` → `false`. Right-click on sprite → minimal in-window menu (Mute/Unmute · Pin/Unpin · Quit) → `ganyu.menuAction(...)`. Speech bubble: styled div above the sprite, fades after 8s, newest replaces current.

### Speech (module D)

`createSpeech({exec, clock, onLine, isMuted})` — `exec` injected (production: `child_process.execFile` of `C:\Users\kw11l\.local\bin\claude` with args `['-p', prompt, '--model', 'haiku']`, 15s timeout, kill on expiry).

- **Chatty mode** (the only mode in v1): speaks on `SessionStart` (greeting), tool-class change during `busy` (e.g. first Bash after edits), `Stop` (completion), `waiting` (nudge), `failed` (sympathy). Global cooldown **45s**; `waiting`/`failed` may interrupt at ≥15s. Queue depth 1 — a newer trigger replaces a pending one.
- Persona prompt template (in `persona.mjs`):
  `You are Ganyu from Genshin Impact, working as {user}'s diligent secretary. React to this coding-agent event in ONE short line (max 90 chars), gentle and dutiful, in English, at most one emoji, occasionally hinting you could use a nap. Event: {summary}. Reply with ONLY the line.`
  `{summary}` = compact human phrase built from the normalized event (`"codex finished a task in ganyu-pet"`, `"Claude Code is waiting for permission to run Bash"`).
- On exec error/timeout/empty output → canned fallback per mode (≥6 lines per mode table in `persona.mjs`), same cooldown rules. Muted → no exec calls at all.

### Wander (module E)

`createWander({clock, schedule, moveWindow, getWorkArea, onWalkState, isPinned})` — all side effects injected; `schedule(fn, ms)` returns a cancel handle (production: setTimeout).

- Arms when aggregate mode is `idle` ≥90s. Then every 2–5 min (deterministic from injected `random`): pick target x in work area, walk at ~60 px/s (move window every 50ms tick), face travel direction (`onWalkState({dir})`), occasional mid-walk pause (idle 3–8s). Any non-idle state change → instant cancel, `onWalkState(null)`. Pinned → never arms. Y stays fixed at bottom edge.

### Hook delivery (module F)

`hooks/ganyu-hook.cmd %1=source [%2=port]` — mirrors Orca's proven pattern: pipe stdin to `%SystemRoot%\System32\curl.exe -sS -X POST http://127.0.0.1:47821/event/%1 --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/json" --data-binary @- >nul 2>&1`, then `exit /b 0` **always** — a dead pet must never block or slow an agent. If curl is missing/fails, drain stdin (`more.com >nul`) and still exit 0.

`hooks/install-hooks.mjs`:
- Targets: `~/.codex/hooks.json` (events: SessionStart, UserPromptSubmit, Stop, PreToolUse, PostToolUse, PermissionRequest, SubagentStart, SubagentStop — same envelope shape as the existing entries in that file) and `~/.claude/settings.json` `hooks` key (events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, SessionEnd; PreToolUse/PostToolUse get `"matcher": "*"`).
- **Append-only merge**: never remove or reorder existing entries (Orca + Superset hooks live there). Skip any event where our exact command already exists (idempotent). Write `<file>.bak-ganyu-N` backup first. Round-trip parse the result before writing; abort on any parse failure.
- Default is dry-run printing a unified-diff-style preview. `--apply` writes. `--codex-file <path> --claude-file <path>` override targets (used by tests against fixtures in `hooks/fixtures/`).

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`). No secrets in code or notes. Keep modules dependency-free except Electron itself (integrator adds `electron` as the only devDependency).
- `npm run start` → `electron .` · `npm test` → `node --test test/` · `npm run smoke` → `node scripts/smoke.mjs` (spawns `electron .` with `GANYU_SMOKE=1`, asserts `SMOKE_OK`, 20s timeout).
