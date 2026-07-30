# ganyu-pet — Contracts & Spec

Desktop pet overlay: Ganyu (from the installed Codex pet `ganyu--chenxin-dlut`) lives on the Windows desktop, reacts to codex CLI **and** Claude Code lifecycle-hook events, chats in character via Haiku, and wanders the bottom edge of the screen whenever nothing needs the owner's attention.

This file is the single source of truth for parallel builders. **Own only your files. Interfaces here are binding.**

## Goal / success criteria (the verifier's checklist)

1. `npm test` (runs `node --test test/*.test.mjs`) — all unit tests pass.
2. `npm run smoke` — Electron launches, creates a frameless transparent always-on-top window, prints `SMOKE_OK {json flags}` and exits 0 within 20s (env `GANYU_SMOKE=1` makes the app self-quit after ~5s).
3. Server + state standalone (`node src/main/server.mjs --standalone --port 47899`): POST a codex-shaped `PreToolUse` payload → `GET /state` reports `busy`; `PermissionRequest` → `waiting`; `Stop` → `idle` with a transient `celebrate` flag; a payload containing an error marker → `failed`.
4. `echo <sample JSON> | cmd /c hooks\ganyu-hook.cmd codex 47899` delivers the payload to a listening server (test with a throwaway node listener).
5. `node hooks/install-hooks.mjs` (dry-run, default) against **fixture copies** of `hooks.json` / `settings.json` produces valid JSON that preserves every pre-existing hook entry and adds ours exactly once (idempotent on re-run). It must never touch real config without `--apply`.
6. Speech unit tests: prompt template correct, 45s global cooldown enforced (15s floor for `waiting`/`failed` interrupts), canned fallback used when the CLI call fails. Live Haiku call is exercised once by the integrator (`claude -p --model haiku`); if offline, flag it — don't fail the build.
7. Wander scheduler unit tests with an injected clock: engages 20s after the aggregate mode becomes calm (`idle` **or** `busy`), picks targets inside the primary display work area, keeps walking across idle↔busy transitions, and cancels immediately on a non-calm mode (`waiting`/`failed`). Containment and physics are covered by the same suite: `bounds()` derives from the **injected measured** window size, `containNow()` recovers her from every edge (and no-ops inside, and works while pinned and while the mode is non-calm), gravity settles her exactly on the floor after at most a few decreasing bounces without exceeding terminal velocity or teleporting on a late tick, and a stroll aimed past a wall turns around instead of stopping dead.
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

Aggregate mode = highest priority across live sessions: `failed > waiting > busy > idle`. Sessions expire after 10 min without events (sweep interval implementation-defined — currently 1s; TTLs unchanged). `celebrate` is a transient flag alongside the mode, not a mode.

State module exposes `createState({clock})` returning `{ingest(source, payload), aggregate(), onChange(cb)}` — injectable clock (`clock.now()`) for tests; production passes `() => Date.now()`.

### IPC contract (A ↔ C, via preload `window.ganyu`)

Preload exposes exactly:
- `ganyu.onState(cb)` — cb receives `{mode, sessionCount, celebrate, walk: {dir: 'left'|'right'} | null}`.
- `ganyu.onSpeak(cb)` — cb receives `{text}`.
- `ganyu.setInteractive(bool)` — toggles `setIgnoreMouseEvents(!bool, {forward: true})`.
- `ganyu.menuAction(action)` — `'toggle-mute' | 'toggle-pin' | 'home' | 'quit'`. `home` is the recall action (see §Window); main filters against `MENU_ACTIONS`, so anything else is dropped.
- `ganyu.getFlags()` → Promise of `{muted, pinned, spritePath}` (spritePath as `file://` URL for the `<img>`/canvas source).

Channels (main side): `ganyu:state`, `ganyu:speak`, `ganyu:set-interactive`, `ganyu:menu`, `ganyu:get-flags`. Nothing else.

### Window (module A)

Frameless, transparent, `alwaysOnTop: 'screen-saver'`, `skipTaskbar`, not resizable, ~256×320 (192×208 sprite + bubble headroom), initial position bottom-right of primary display `workArea`, `webPreferences: {contextIsolation: true, preload: preload.cjs}`. Default click-through ON via `setIgnoreMouseEvents(true, {forward: true})`; renderer flips interactivity on sprite hover (see C). `GANYU_SMOKE=1` → after ~5s print `SMOKE_OK ` + JSON `{transparent, alwaysOnTop, frame:false}` to stdout and `app.quit()`. Single-instance lock. Wires modules together: server → state → (renderer push, speech, wander).

**Measured size, not `WINDOW_SIZE` — and measured exactly once.** Two facts about this machine (Electron 43.2.0 / Windows 11 22000, primary display `workArea` 1707×1019, `scaleFactor` 1.5), both measured live:

1. Windows adds invisible frame padding even to a frameless transparent window: a 256×320 request measures **259×323**. Clamping the pet against `WINDOW_SIZE` therefore left her right and bottom edges ~3px outside the work area.
2. **`win.getBounds()` is not a stable size.** Every `setPosition` inflates the reported width and height by ~1px — 259×323 at create, 458×523 after 200 moves — and `setSize(256, 320)` does not reset it. It is a DIP↔physical round-tripping artifact of the 1.5 scale factor.

So module A captures the size **once, before anything calls `setPosition`**, caches it, and hands that to everything that needs geometry: wander's `getWindowSize`, `computeInitialBounds` for the recall target, and the hover watch's bounds (live position + stable size — the inflating size slid the sprite's hover box off the sprite the longer she walked, until the right-click menu could not be opened). Re-reading the size live walks the pet up the screen ~1px per tick; do not "fix" it back into a live read. Production values: **maxX 1448, floor 696**.

**Containment.** Module A calls `wander.containNow()` (a) once on startup, right after the window exists — the initial `computeInitialBounds` placement is derived from `WINDOW_SIZE` and is already ~3px outside; (b) from the existing 1s state poll, which is cheap because module E no-ops when she is already inside; and (c) on the `screen` events `display-metrics-changed`, `display-added` and `display-removed`. Listeners are removed in `cleanup()`.

**Recall.** `MENU_ACTIONS` is `['toggle-mute', 'toggle-pin', 'home', 'quit']`. `home` cancels any stroll (or its next tick drags her straight back out), snaps the window to `computeInitialBounds(workArea, measuredSize)`, and calls `containNow()` to resync module E's tracked position. It is the last resort for a pet the owner cannot reach, and works while pinned and while the aggregate mode is stuck non-calm.

### Renderer (module C)

Canvas-based sprite engine. Spritesheet grid — 8 columns × 9 rows, frame 192×208, row map:

| Row | Animation |
|---|---|
| 0 idle · 1 run-right · 2 run-left · 3 waving · 4 jumping · 5 failed · 6 waiting · 7 busy (non-directional) · 8 review |

**Frames per row are not uniform.** The grid is 8 wide but only rows 1, 2 and 5 fill it; the rest end early and their trailing cells are fully transparent. Measured opaque-pixel counts (`ROW_FRAMES` in `pet.mjs`):

| Row | 0 idle | 1 run-right | 2 run-left | 3 waving | 4 jumping | 5 failed | 6 waiting | 7 busy | 8 review |
|---|---|---|---|---|---|---|---|---|---|
| Frames | 6 | 8 | 8 | 4 | 5 | 8 | 6 | 6 | 6 |

Mode → row: `idle→0`, `busy→7`, `waiting→6`, `failed→5`, `celebrate` pulse → 4 (jump) then 3 (wave) once, `walk.dir right→1 / left→2`. 8 fps default, 6 fps for walk rows. Loop each row's real frame count, never the full 8 — drawing a blank trailing cell blinks the pet out (idle at 8 fps lost 250ms of every second). Chromium decodes `.webp` natively — draw via offscreen `<img>` → `drawImage` crops.

Hover behavior: `mouseenter` on the sprite's bounding box → `ganyu.setInteractive(true)`; `mouseleave` → `false`. Right-click on sprite → minimal in-window menu (Mute/Unmute · Pin/Unpin · **Home** · Quit) → `ganyu.menuAction(...)`. `home` is wired end to end in main (§Window) but **module C has not added the menu entry yet**, so the recall action is reachable over IPC and unlabelled in the UI until it does. Speech bubble: styled div above the sprite, fades after 8s, newest replaces current.

### Speech (module D)

`createSpeech({exec, clock, onLine, isMuted})` — `exec` injected (production: `child_process.execFile` of `C:\Users\kw11l\.local\bin\claude` with args `['-p', prompt, '--model', 'haiku']`, 60s timeout, kill on expiry — measured CLI latency on this machine is 23–57s, so 15s starved every live call).

- **Chatty mode** (the only mode in v1): speaks on `SessionStart` (greeting), tool-class change during `busy` (e.g. first Bash after edits), `Stop` (completion), `waiting` (nudge), `failed` (sympathy). Global cooldown **45s**; `waiting`/`failed` may interrupt at ≥15s. Queue depth 1 — a newer trigger replaces a pending one.
- Persona prompt template (in `persona.mjs`):
  `You are Ganyu from Genshin Impact, working as {user}'s diligent secretary. React to this coding-agent event in ONE short line (max 90 chars), gentle and dutiful, in English, at most one emoji, occasionally hinting you could use a nap. Address them by name only, never with an honorific (no Mr., Miss, or Sir). Event: {summary}. Reply with ONLY the line.`
  Default `{user}` is **Kahweng** (owner's preferred name — no honorific, never "Mr."; `GANYU_USER` env overrides).
  `{summary}` = compact human phrase built from the normalized event (`"codex finished a task in ganyu-pet"`, `"Claude Code is waiting for permission to run Bash"`).
- On exec error/timeout/empty output → canned fallback per mode (≥6 lines per mode table in `persona.mjs`), same cooldown rules. Muted → no exec calls at all.

### Wander (module E)

`createWander({clock, schedule, moveWindow, getWorkArea, getWindowSize, getPosition, onWalkState, isPinned})` — all side effects injected; `schedule(fn, ms)` returns a cancel handle (production: setTimeout).

- `getWindowSize()` → `{width, height}`: the **measured** outer size of the window, read on every `bounds()` call. Falls back to the `windowWidth`/`windowHeight` defaults (256×320) when absent or when it returns garbage, so unit tests need not inject it. See §Window for why module A measures once and caches rather than reading `getBounds()` live.
- `getPosition()` → `{x, y}`: where the window really is, drags included. This is what makes containment possible at all — without it the module only knows the position it last set. Ignored while she is strolling or falling, because mid-motion the module owns the position and re-reading a rounded value each tick would fight the float integration.

- **Calm modes** (`WANDER_DEFAULTS`-adjacent export `CALM_MODES = ['idle', 'busy']`, plus an `isCalm(mode)` helper): she strolls while the aggregate mode is `idle` **or** `busy`. `busy` counts as calm because the owner always has codex/Claude Code sessions open, so the lifecycle-hook stream pins the aggregate at `busy` indefinitely and `idle` effectively never arrives — gating on `idle` alone meant she never walked at all, just looped the non-directional busy run on the spot.
- Arms **20s** after entering a calm mode from a non-calm one. Then every **45–120s** (deterministic from injected `random`): pick target x in work area, walk at ~60 px/s (move window every 50ms tick), face travel direction (`onWalkState({dir})`), occasional mid-walk pause (idle 3–8s).
- A transition **between** two calm modes (idle↔busy, which the hook stream does constantly as sessions start and stop) neither interrupts a stroll in progress nor restarts the countdown. Only a **non-calm** mode (`waiting`, `failed`, or any unrecognized mode) → instant cancel, `onWalkState(null)`. Repeated identical modes are ignored. Pinned → never arms.
- **Edge bounce.** Targets are always picked inside the work area, but a wall can move under her mid-stroll (the work area shrinks, a monitor is undocked). When the next step would cross `minX`/`maxX` she stops at the wall, picks a fresh target back the other way, and flips the direction reported through `onWalkState` — she turns around rather than stopping dead against the edge. Arrival still wins over the wall check, so a target sitting exactly on an edge ends the stroll normally.
- Renderer precedence follows from this: `walk.dir` outranks the mode row, so a stroll under `busy` draws the directional run rows (1/2), not the run-in-place row 7.

**Containment — `containNow()`.** Re-clamps the window into the current work area from wherever it is, then hands off to gravity if it is above the floor. Callable at any time from any state: **no mode check, no pinned check, no stroll required**, and a no-op (not one `moveWindow` call) when she is already fully inside. Returns true if it moved her. This is the fix for the owner losing the pet off-screen: `syncPosition()` alone only re-clamped at the *start* of a stroll, so a work-area change or a drag left her outside with nothing to pull her back — and with the aggregate mode stuck non-calm (`waiting`/`failed`) wander is cancelled and no stroll ever comes, so she stayed lost indefinitely. **Pinned does not exempt containment**: a pinned pet stranded off-screen was exactly the trap. Module A's call sites are in §Window.

**Physics.** `WANDER_DEFAULTS` adds `gravityPxPerSec2: 1400`, `maxFallPxPerSec: 900`, `restitution: 0.25`, `minBounceVelocity: 120`.

- **Floor** = work area bottom minus the **measured** window height. Y is no longer a constant: it changes while she falls, and `moveWindow` receives the updated y. The renderer is unaffected — it draws in-window.
- Whenever she is above the floor — dragged up, or left high by a display change — she **falls**: `vy += gravity·dt`, `y += vy·dt`, capped at `maxFallPxPerSec`, on the existing `tickMs` cadence with the same `maxTickDtMs` clamp so a suspended timer cannot teleport her. On reaching the floor she bounces with `restitution`, and once the rebound is below `minBounceVelocity` she settles **exactly** on the floor. With these constants that is one or two bounces.
- **Falling outranks strolling**: it cancels a stroll in progress (`onWalkState(null)`), then normal scheduling resumes on landing. It also outranks the mode and the pinned flag — gravity is containment, not behaviour, so it runs while pinned and while the mode is non-calm. Only `stop()` (teardown) cancels a fall; `cancel()` and a non-calm `setMode` deliberately leave it running rather than leaving her hanging in mid-air.
- Diagnostics: `isFalling()` alongside `isWandering()` / `isArmed()`. Falling is deliberately *not* "armed" and *not* "wandering".

### Hook delivery (module F)

`hooks/ganyu-hook.cmd %1=source [%2=port]` — mirrors Orca's proven pattern: pipe stdin to `%SystemRoot%\System32\curl.exe -sS -X POST http://127.0.0.1:47821/event/%1 --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/json" --data-binary @- >nul 2>&1`, then `exit /b 0` **always** — a dead pet must never block or slow an agent. If curl is missing/fails, drain stdin (`more.com >nul`) and still exit 0.

`hooks/install-hooks.mjs`:
- Targets: `~/.codex/hooks.json` (events: SessionStart, UserPromptSubmit, Stop, PreToolUse, PostToolUse, PermissionRequest, SubagentStart, SubagentStop — same envelope shape as the existing entries in that file) and `~/.claude/settings.json` `hooks` key (events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, SessionEnd; PreToolUse/PostToolUse get `"matcher": "*"`).
- **Append-only merge**: never remove or reorder existing entries (Orca + Superset hooks live there). Skip any event where our exact command already exists (idempotent). Write `<file>.bak-ganyu-N` backup first. Round-trip parse the result before writing; abort on any parse failure.
- Default is dry-run printing a unified-diff-style preview. `--apply` writes. `--codex-file <path> --claude-file <path>` override targets (used by tests against fixtures in `hooks/fixtures/`).

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`). No secrets in code or notes. Keep modules dependency-free except Electron itself (integrator adds `electron` as the only devDependency).
- `npm run start` → `electron .` · `npm test` → `node --test test/` · `npm run smoke` → `node scripts/smoke.mjs` (spawns `electron .` with `GANYU_SMOKE=1`, asserts `SMOKE_OK`, 20s timeout).
