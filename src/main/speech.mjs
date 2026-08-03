// Module D — speech: decides when Ganyu says something and turns the hook event
// into a status line.
//
// Two sources, one gate. The deterministic MESSAGES table in persona.mjs is the
// baseline and is always available: the bubble is a status indicator, so for
// `waiting` / `failed` it has to appear the instant the event lands, which no
// network round-trip can promise. An optional brain (brain.mjs) writes a better
// line for the same event; when it arrives in time it replaces the canned one,
// and when it doesn't — unconfigured, slow, failing — nothing about the old
// behaviour changes. Both sources emit through `show()`, so mute and the
// throttle gate them identically.
// No Electron import; every side effect is injectable.

import { RECENT_WINDOW_MS, basename, describeAction, pickToolInput, projectFromCwd } from './context.mjs';
import { LEDGER_KINDS } from './ledger.mjs';
import { BUILTIN_PERSONA, buildSummary, createMentionMemory, messageFor } from './persona.mjs';

/**
 * Floor between two lines of the *same* urgent kind. Urgent lines are otherwise
 * immediate, but seven sessions hitting the same wall inside two seconds is one
 * piece of news, not seven bubbles.
 */
export const THROTTLE_MS = 6_000;

/**
 * Gap required for every non-urgent line. Was 6s, which — with several agents
 * emitting PreToolUse/PostToolUse continuously — meant a line about every tenth
 * Read she happened to catch. Silence is what makes the remaining lines mean
 * anything, so the cost of a line went up by 15x.
 */
export const QUIET_THROTTLE_MS = 90_000;

/** After this much silence, the next thing worth a trigger is worth hearing. */
export const QUIET_STRETCH_MS = 10 * 60 * 1000;

/** At most one "I noticed a pattern" line per this long. */
export const NOTABLE_INTERVAL_MS = 10 * 60 * 1000;

/** How far back the pattern tallies look. Same window context.mjs summarises over. */
export const PATTERN_WINDOW_MS = RECENT_WINDOW_MS;

/** What counts as a pattern rather than ordinary work. */
export const REPEAT_FILE_TIMES = 5;
export const REPEAT_COMMAND_TIMES = 3;
export const PROJECT_RUN_EVENTS = 25;
export const SESSION_SURGE_COUNT = 4;

/**
 * Failures worth a line: the first, then only when the streak grows notably.
 * Narrating every retry is how a sympathetic line becomes nagging.
 */
export const FAILURE_STREAK_STEPS = Object.freeze([1, 3, 5]);

/** How many of her own lines she remembers, and is reminded of, at a time. */
export const RECENT_LINES = 3;

/**
 * How long a line waits for its own audio before giving up and showing itself
 * unvoiced. The bubble and the voice are two halves of one utterance; shipping
 * the words seconds ahead of the sound is what made her feel broken.
 *
 * **Why 3.5s and not the ~500ms the warm socket suggests.** Measured against the
 * live Edge endpoint on 2026-07-31, twelve of her own lines on one reused socket:
 * min 396ms, median 2327ms, p90 3090ms, max 4313ms (mean 2183ms). The variance is
 * the endpoint's, not the connection's — time-to-first-audio-frame alone ranged
 * 277–2311ms on that same socket. A 2s deadline would expire on roughly half of
 * all lines, which is a feature that does not work; 3.5s clears p90, so about
 * nine lines in ten land with their voice.
 *
 * **What it is actually protecting against.** Almost nothing waits this out. A
 * refused socket, a dead endpoint, a socket that dies mid-sentence and a voice
 * that is switched off all resolve `speak()` to null in milliseconds, so the
 * common failures show the bubble immediately rather than at the deadline. The
 * cases this bounds are the two hangs: a connect that never completes
 * (CONNECT_TIMEOUT_MS, 5s) and a socket that accepts the request and never
 * answers (SPEAK_TIMEOUT_MS, 10s). Sitting well under both is the point — it is
 * a floor on how long she may be silent *and* invisible, not a latency budget.
 */
export const AUDIO_HOLD_MS = 3_500;

export const INTERRUPT_KINDS = new Set(['waiting', 'failed']);

/** Kinds that are always worth a line: the moments the owner asked to always see. */
export const ALWAYS_KINDS = new Set(['greeting', 'celebrate', 'recovered']);

/** How long a line of each salience level must wait behind the previous one. */
const THROTTLE_FOR = { urgent: 0, always: QUIET_THROTTLE_MS, notable: QUIET_THROTTLE_MS };

const isNotableStreak = (n) => FAILURE_STREAK_STEPS.includes(n) || (n > 5 && n % 5 === 0);

/**
 * `salienceOf({kind, failStreak, quietForMs, sinceNotableMs, patterns})`
 *   -> `{level: 'urgent'|'always'|'notable'|null, reason}`
 *
 * Whether this is worth interrupting him for. Pure: everything it reads is
 * passed in, so a test names a situation directly instead of replaying twenty
 * events to reach it. It lives here rather than in context.mjs because it is a
 * decision about *speaking*, and context.mjs is deliberately a set of pure
 * functions over module B's ring with no notion of what the pet has said.
 *
 * `patterns` is the list of notable things this event completed (see
 * `trackPatterns`); an empty list is ordinary work, which is most of it.
 */
export function salienceOf({
  kind = null,
  failStreak = 0,
  quietForMs = Infinity,
  sinceNotableMs = Infinity,
  patterns = [],
} = {}) {
  if (!kind) return { level: null, reason: 'no-trigger' };
  if (kind === 'waiting') return { level: 'urgent', reason: 'waiting' };
  if (kind === 'failed') {
    if (!isNotableStreak(failStreak)) return { level: null, reason: 'repeat-failure' };
    return { level: 'urgent', reason: failStreak <= 1 ? 'failure' : `failure-streak-${failStreak}` };
  }
  if (ALWAYS_KINDS.has(kind)) return { level: 'always', reason: kind };
  // She has said nothing for ten minutes; the next real trigger is allowed
  // through whatever it is, so a long working stretch is not total silence.
  if (quietForMs >= QUIET_STRETCH_MS) return { level: 'always', reason: 'long-quiet' };
  if (patterns.length > 0 && sinceNotableMs >= NOTABLE_INTERVAL_MS) {
    return { level: 'notable', reason: patterns[0] };
  }
  return { level: null, reason: 'routine' };
}

const BUSY_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
]);
const WAITING_EVENTS = new Set(['PermissionRequest', 'Notification']);
const IDLE_EVENTS = new Set(['Stop', 'SessionEnd']);

const TOOL_CLASS_PATTERNS = [
  [/^(bash|shell|powershell|pwsh|cmd|exec|local_shell|run_command|terminal)/i, 'shell'],
  [/^(edit|write|multiedit|notebookedit|apply_patch|patch|update_file|str_replace|create_file)/i, 'edit'],
  [/^(read|glob|grep|ls|list|search|view|find)/i, 'read'],
  [/^(webfetch|websearch|fetch|browse|http)/i, 'web'],
  [/^(task|agent|subagent|dispatch|workflow)/i, 'agent'],
];

/** Coarse tool grouping so "first Bash after a run of edits" registers as a change. */
export function toolClass(name) {
  if (!name) return 'none';
  const s = String(name);
  for (const [re, cls] of TOOL_CLASS_PATTERNS) if (re.test(s)) return cls;
  return s.toLowerCase();
}

/**
 * Something actually finished, and it worked. Only a completion counts: a
 * `PreToolUse` is "about to run it again", which during a retry loop is the most
 * common event of all and says nothing about whether the trouble has cleared.
 */
const succeeded = (ev) =>
  !ev.errorish && (ev.event === 'PostToolUse' || IDLE_EVENTS.has(ev.event));

/** Same event→mode table as module B; used only when the caller does not supply `mode`. */
export function modeForEvent(event, errorish = false) {
  if (errorish) return 'failed';
  if (!event) return null;
  if (WAITING_EVENTS.has(event)) return 'waiting';
  if (IDLE_EVENTS.has(event)) return 'idle';
  if (BUSY_EVENTS.has(event)) return 'busy';
  return null;
}

/** A tool name may arrive as a string or as an object ({name} / {tool_name}). */
export function toolNameOf(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const nested = value.name ?? value.tool_name ?? value.toolName ?? null;
    return typeof nested === 'string' && nested !== '' ? nested : null;
  }
  const s = String(value);
  return s === '' ? null : s;
}

/**
 * Last path segment, tolerant of both Windows and POSIX separators — with one
 * exception, which is why it lives in context.mjs rather than here: an Orca
 * worktree keeps `<repo>/<worktree>`, since "bay-daily-codes" alone does not say
 * which repo it belongs to.
 */
export const projectName = projectFromCwd;

/**
 * createSpeech({clock, onLine, isMuted, random, brain})
 *
 * clock    — {now()} or a () => ms function.
 * onLine   — called with {text, kind, mode, source, summary, audio?}, which is
 *            the ganyu:speak payload. Synchronous when there is no voice to wait
 *            for, and otherwise up to `audioHoldMs` later, carrying the audio it
 *            waited for — see `show()`. The *decision* to show is always
 *            synchronous; only the call is deferred.
 * isMuted  — () => bool. Muted means no line at all.
 * random   — injectable for deterministic variant choice in tests.
 * brain    — optional {requestLine({detail, summary})} -> Promise<string|null>.
 *            Absent (the default) is the original synchronous behaviour, exactly.
 * mentionMemory — the suppression state for the rate-limited briefing lines
 *            (persona.createMentionMemory). Injectable so a test can start her
 *            mid-evening, having already mentioned the hour.
 * ledger   — optional {record(entry)} (ledger.createLedger). Absent is the
 *            original behaviour: she reacts and forgets.
 * voice    — optional {speak(text, {kind})} -> Promise<audio|null> (voice.mjs).
 *            Absent is the original behaviour: she is read, not heard.
 * onAudio  — where late audio goes (module A sends it to the renderer) for the
 *            lines that are shown before their sound exists: urgent kinds, and
 *            any line whose synthesis overran AUDIO_HOLD_MS. Called with
 *            {mime, base64, kind, text}. Audio that arrives in time does not
 *            come through here at all — it rides on `onLine` instead.
 * audioHoldMs — how long a held line waits for its audio. See AUDIO_HOLD_MS.
 * schedule/cancel — the hold's timer, injectable so tests need no real clock.
 */
export function createSpeech({
  clock = { now: () => Date.now() },
  onLine = () => {},
  isMuted = () => false,
  random = Math.random,
  brain = null,
  mentionMemory = createMentionMemory(),
  ledger = null,
  voice = null,
  onAudio = () => {},
  audioHoldMs = AUDIO_HOLD_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  // See createBrain: injected, never imported, for the same reason.
  persona = BUILTIN_PERSONA,
} = {}) {
  const now = () => (typeof clock === 'function' ? clock() : clock.now());
  const muted = () => (typeof isMuted === 'function' ? Boolean(isMuted()) : Boolean(isMuted));

  const askBrain = typeof brain?.requestLine === 'function' ? brain : null;
  const diary = typeof ledger?.record === 'function' ? ledger : null;
  const talker = typeof voice?.speak === 'function' ? voice : null;

  let lastSpokeAt = null;
  let lastKind = null;
  let lastMode = null;
  let shownCount = 0; // bumped on every emitted line; a brain reply for an older one is stale
  let failStreak = 0; // consecutive failures; only some of them are worth a line
  let lastNotableAt = null; // when she last remarked on a pattern
  /**
   * The one line waiting for its own audio, or null. A slot rather than a queue,
   * and the reason ordering holds: a line that has decided to show cancels
   * whatever was waiting, so two lines can never arrive out of order and a stale
   * one can never overwrite the line that displaced it.
   */
  let held = null;
  const toolClasses = new Map(); // sessionId -> last tool class
  // What the last PATTERN_WINDOW_MS looked like, kept only as far as the four
  // patterns below need: one small record per event, pruned by age. This is not
  // a second copy of context.summarizeRecent — that reads module B's ring, which
  // speech has no access to, and it is one event behind at the moment speech runs.
  const trail = [];
  // The last few lines she actually said, newest first. One store serving two
  // readers: `avoid` keeps the canned table off the variant it just used, and the
  // brain is told the same lines so it does not paraphrase itself all evening.
  const recentLines = [];

  function rememberLine(kind, text, fromTable) {
    recentLines.unshift({ kind, text, fromTable });
    if (recentLines.length > RECENT_LINES) recentLines.length = RECENT_LINES;
  }

  /** Only table lines: a generated line is never a variant, so it would disable `avoid`. */
  const avoidFor = (kind) => recentLines.find((l) => l.fromTable && l.kind === kind)?.text ?? null;
  const spokenLines = () => recentLines.map((l) => l.text);

  function rememberClass(sessionId, cls) {
    toolClasses.delete(sessionId);
    toolClasses.set(sessionId, cls);
    if (toolClasses.size > 32) toolClasses.delete(toolClasses.keys().next().value);
  }

  const countIn = (key, value) => trail.reduce((n, e) => n + (e[key] === value ? 1 : 0), 0);

  /**
   * Record this event and report which patterns it completes, commonest phrasing
   * first. These are the only things routine tool traffic is ever allowed to
   * interrupt him for — and even then only once per NOTABLE_INTERVAL_MS.
   */
  function trackPatterns(ev, t) {
    const input = ev.toolInput ?? {};
    trail.push({
      at: t,
      file: basename(input.file_path ?? input.notebook_path ?? input.path),
      command: input.command ?? null,
      project: ev.project ?? null,
      sessionId: ev.sessionId ?? null,
    });
    const cutoff = t - PATTERN_WINDOW_MS;
    while (trail.length > 0 && trail[0].at < cutoff) trail.shift();
    if (trail.length > 400) trail.splice(0, trail.length - 400);

    const last = trail[trail.length - 1];
    const patterns = [];
    if (last.file && countIn('file', last.file) >= REPEAT_FILE_TIMES) patterns.push('repeat-file');
    if (last.command && countIn('command', last.command) >= REPEAT_COMMAND_TIMES) {
      patterns.push('repeat-command');
    }
    const sessions = new Set(trail.map((e) => e.sessionId).filter(Boolean));
    if (sessions.size >= SESSION_SURGE_COUNT) patterns.push('many-sessions');
    if (last.project) {
      let run = 0;
      for (let i = trail.length - 1; i >= 0 && trail[i].project === last.project; i -= 1) run += 1;
      if (run >= PROJECT_RUN_EVENTS) patterns.push('project-run');
    }
    return patterns;
  }

  function normalizeEvent(input = {}) {
    const p = input.payload && typeof input.payload === 'object' ? input.payload : {};
    const source = input.source ?? p.source ?? 'agent';
    const event = input.event ?? p.hook_event_name ?? p.event ?? p.type ?? null;
    const sessionId =
      input.sessionId ?? p.session_id ?? p.thread_id ?? p.sessionId ?? `${source}-unknown`;
    // `tool` and `failed` are module B's spellings (state.mjs normalizeEvent) and
    // module A forwards B's normalized event verbatim, with no `payload`. Reading
    // only `toolName`/`errorish` left toolName null in production, so the busy
    // trigger could never fire and the line never carried a tool name.
    const toolName = toolNameOf(input.toolName ?? input.tool ?? p.tool_name ?? p.toolName ?? p.tool);
    const project =
      input.project ?? projectName(input.cwd ?? p.cwd ?? p.project_dir ?? p.workspace ?? null);
    // Whether something failed is module B's call (state.mjs hasErrorMarker), and
    // speech trusts it. Speech used to re-derive it by scanning payload text,
    // which flagged 36 of 42 live events as failures.
    const errorish = Boolean(input.errorish ?? input.failed);
    // An errorish event is `failed` whatever its event name says: a PostToolUse
    // carrying an error arrives with mode 'busy', which would otherwise shadow it.
    const mode = errorish ? 'failed' : (input.mode ?? modeForEvent(event, errorish));
    // What the tool was actually asked to do — the difference between "running a
    // tool" and "editing persona.mjs". Reduced to the allowlisted keys here, at
    // the edge, so the keys carrying his code (old_string, content, prompt) do
    // not travel any further into the app than the event that carried them.
    const toolInput = pickToolInput(input.toolInput ?? input.tool_input ?? p.tool_input);
    const agentType = input.agentType ?? p.agent_type ?? null;
    return { source, event, sessionId, toolName, project, errorish, mode, toolInput, agentType };
  }

  /** Trigger rules. Also updates mode / tool-class tracking. */
  function decideTrigger(ev) {
    const prevMode = lastMode;
    if (ev.mode) lastMode = ev.mode;

    const prevClass = toolClasses.get(ev.sessionId) ?? null;
    const cls = toolClass(ev.toolName);
    if (cls !== 'none') rememberClass(ev.sessionId, cls);

    if (ev.mode === 'failed' && (prevMode !== 'failed' || ev.errorish)) return 'failed';
    if (ev.mode === 'waiting' && (prevMode !== 'waiting' || WAITING_EVENTS.has(ev.event))) {
      return 'waiting';
    }
    if (ev.event === 'SessionStart') return 'greeting';
    if (IDLE_EVENTS.has(ev.event)) return 'celebrate';
    // The first thing that *finishes* successfully after something broke. It has
    // to be a completion, not a PreToolUse: "about to run it again" says nothing
    // about whether it works, and treating a retry as a recovery would clear the
    // failure streak on every attempt. No tool-class change is required — that it
    // came back at all is the news. Module B's event carries its own mode
    // (`busy`), not the session's sticky `failed`, so this fires on the next
    // successful step rather than 30 seconds later.
    if (prevMode === 'failed' && succeeded(ev)) return 'recovered';
    if (ev.mode === 'busy' && cls !== 'none' && prevClass !== null && cls !== prevClass) {
      return 'busy';
    }
    return null;
  }

  /**
   * How long this line must wait. Urgent kinds are immediate, except against
   * another line of the same urgent kind; everything else waits out
   * QUIET_THROTTLE_MS. The first line she ever says never waits.
   */
  function waitFor(level, kind, t) {
    if (lastSpokeAt === null) return 0;
    const elapsed = t - lastSpokeAt;
    const gap = level === 'urgent'
      ? (kind === lastKind ? THROTTLE_MS : 0)
      : (THROTTLE_FOR[level] ?? QUIET_THROTTLE_MS);
    return Math.max(0, gap - elapsed);
  }

  function emit(line) {
    try {
      onLine(line);
    } catch {
      /* never let a listener break the pet */
    }
  }

  /**
   * Audio for a line that is already on screen — an urgent kind, or one whose
   * synthesis overran the hold. This is the old behaviour, kept for exactly the
   * cases where the words genuinely could not wait for the sound.
   *
   * Two things are re-checked here rather than when the audio was asked for, for
   * the same reason `awaitBrain` re-checks them: synthesis takes a second or
   * more, and in that time he may have muted her, or a newer line may have taken
   * the bubble — in which case this one is about old news and playing it would
   * put her voice out of step with what he is reading.
   */
  function deliverLate({ seq, kind, text }, audio) {
    if (!audio || shownCount !== seq || muted()) return;
    try {
      onAudio({ ...audio, kind, text });
    } catch {
      /* the same promise the line listener gets */
    }
  }

  /**
   * Synthesize without holding anything back. Fire-and-forget: nothing waits on
   * it, nothing is retried, and a synthesizer that is down costs her the sound
   * and not the line.
   */
  function speakAloud(kind, text, seq) {
    if (!talker) return;
    Promise.resolve()
      .then(() => talker.speak(text, { kind }))
      .then((audio) => deliverLate({ seq, kind, text }, audio))
      .catch(() => {
        /* speak() is contracted not to reject; a pet who cannot speak still writes */
      });
  }

  /** Put a held line into the bubble, with its audio if the audio made it. */
  function release(pending, audio) {
    if (pending.done || pending.dropped) return;
    pending.done = true;
    if (pending.timer !== null) cancel(pending.timer);
    pending.timer = null;
    if (held === pending) held = null;
    // Muted somewhere between the decision and now: she still shows the line she
    // had already decided to show, and simply does not say it. Swallowing the
    // bubble too would make muting her look like turning her off.
    emit(audio && !muted() ? { ...pending.line, audio } : pending.line);
  }

  /**
   * A newer line has taken the bubble, so this one is abandoned: it is never
   * shown and its audio is never played. Dropped rather than shown late because
   * a bubble that appears only to be replaced a moment later is worse than one
   * that never appeared, and because showing it after the newer line would be
   * the reordering this slot exists to prevent.
   */
  function dropHold() {
    if (!held) return;
    const pending = held;
    held = null;
    pending.dropped = true;
    if (pending.timer !== null) cancel(pending.timer);
    pending.timer = null;
  }

  /**
   * Hold one line back until its audio is ready, then show and play it in the
   * same tick. This is the whole of the fix: synthesis takes seconds, so a line
   * emitted the instant it was decided is a line he reads in silence and then
   * hears narrated after he has moved on.
   *
   * Nothing here can leave her permanently quiet. The deadline shows the line
   * unvoiced; a failed synthesis resolves null and shows it immediately; and a
   * newer line drops this one outright.
   */
  function holdFor(line, kind, text, seq) {
    const pending = { seq, line, kind, text, timer: null, done: false, dropped: false };
    held = pending;
    pending.timer = schedule(() => {
      pending.timer = null;
      release(pending, null);
    }, audioHoldMs);

    Promise.resolve()
      .then(() => talker.speak(text, { kind }))
      .then((audio) => {
        if (pending.dropped) return;
        if (!pending.done) {
          release(pending, audio);
          return;
        }
        // The deadline already put the words up. The sound still belongs to
        // them, so it is played late rather than thrown away — a slow endpoint
        // should cost her the sync, not the voice.
        deliverLate(pending, audio);
      })
      .catch(() => {
        if (!pending.dropped) release(pending, null);
      });
  }

  /**
   * The single gate every line passes through, canned or generated. Mute and the
   * throttle are checked here rather than at the trigger, because a brain reply
   * is shown some seconds after its event: by then the owner may have muted her,
   * or a newer line may already own the bubble.
   */
  /**
   * `replacing` is the brain upgrading a canned line already in the bubble, not
   * a second line asking for attention: it must skip the throttle (the same-kind
   * urgent floor would otherwise refuse every replacement, since the line it is
   * replacing is by definition the same kind, six seconds ago at most). Mute and
   * the staleness check still apply — `awaitBrain` has already proved nothing
   * else took the bubble meanwhile.
   */
  /**
   * Deciding and showing are deliberately two different moments now. Everything
   * that makes this a *decision* — the throttle, `lastSpokeAt`, `shownCount`,
   * the recent-lines memory, the descriptor this returns — happens synchronously,
   * exactly as it always did. Only the emit may be deferred, and only to let the
   * line's audio catch up with it.
   *
   * That split is what keeps the rest of the module honest: `waitFor` still sees
   * a line as spoken the instant it was allowed through, so a held line still
   * blocks the next one, and `awaitBrain`'s staleness check still compares
   * against a count that moves at decision time rather than at paint time.
   */
  function show(kind, text, ev, summary, { fromTable = true, level = 'always', replacing = false } = {}) {
    if (!text) return { spoken: false, reason: 'no-line', kind, summary };
    if (muted()) return { spoken: false, reason: 'muted', kind, summary };

    const t = now();
    const wait = replacing ? 0 : waitFor(level, kind, t);
    if (wait > 0) {
      // Dropped, not queued: a status line is only useful while it is still
      // true, and a queued one would narrate work that ended minutes ago.
      return { spoken: false, reason: 'throttled', kind, retryInMs: wait, summary };
    }

    rememberLine(kind, text, fromTable);
    lastSpokeAt = t;
    lastKind = kind;
    shownCount += 1;
    const seq = shownCount;
    const line = { text, kind, mode: ev.mode ?? null, source: ev.source, summary };

    // This line has the bubble now, so anything still waiting for its audio has
    // been overtaken and is abandoned.
    dropHold();

    // Two kinds of line are never held.
    //
    // **Urgent ones**, because their whole value is latency: `waiting` and
    // `failed` are why the pet exists at all, and holding "Claude needs your
    // approval" for three seconds to wait on a synthesizer would trade the one
    // thing this bubble is for against the polish of hearing it in sync. They
    // show at once and are voiced when the audio lands, which is what every line
    // did before this hold existed.
    //
    // **And any line at all when there is no voice** — muted, `GANYU_VOICE=off`,
    // ambient speech turned off — because then there is nothing to wait for, and
    // a pet whose bubbles got slower the moment he silenced her would be a
    // strange way to honour the request.
    if (!talker || INTERRUPT_KINDS.has(kind)) {
      emit(line);
      speakAloud(kind, text, seq);
      return { spoken: true, reason: 'spoken', kind, text, summary };
    }

    holdFor(line, kind, text, seq);
    return { spoken: true, reason: 'spoken', kind, text, summary };
  }

  /**
   * What the brain is told about the event. Metadata only — see brain.mjs.
   * `narration` carries the mention-suppression state through to
   * persona.buildBrainInput, which is the only place that can see both it and
   * the context the decision reads.
   */
  function brainDetail(ev, kind, narration) {
    return {
      kind,
      event: ev.event,
      tool: ev.toolName,
      project: ev.project,
      mode: ev.mode ?? null,
      source: ev.source,
      toolInput: ev.toolInput ?? {},
      agentType: ev.agentType ?? null,
      recentLines: spokenLines(),
      narration,
    };
  }

  /**
   * Write one salient moment into the ledger, so that "I've noted it" is a true
   * sentence rather than the register talking. Nothing here re-derives salience:
   * the caller has already decided, and this only translates the decision.
   *
   *   level 'notable'  -> kind `notable`, detail = the pattern remarked on
   *                       ('repeat-file'), which ledger.digest phrases.
   *   kind in LEDGER_KINDS -> itself, detail = what the tool was doing
   *                       ('running `npm test`'), from the allowlisted toolInput.
   *   anything else    -> nothing. In practice that is `busy`: a tool-class
   *                       change during ordinary work is exactly the traffic the
   *                       ledger exists to keep out, even on the evening a long
   *                       silence promotes one to `always`.
   *
   * Called before the throttle rather than after: a bubble she had no room for
   * is a line not shown, not a thing that did not happen, and the digest is the
   * one place a suppressed failure can still reach him. It is called after the
   * mute gate, though, which is where `notify` returns — muted is a quiet
   * evening in the record as well as on screen.
   *
   * Metadata only, and only ENTRY_KEYS of it. `sanitizeEntry` defends the disk
   * independently; nothing here relies on that.
   */
  function remember(ev, kind, level, reason, t) {
    if (!diary) return;
    const ledgerKind = level === 'notable' ? 'notable' : (LEDGER_KINDS.includes(kind) ? kind : null);
    if (!ledgerKind) return;
    const detail = ledgerKind === 'notable'
      ? reason
      : describeAction({
        tool_name: ev.toolName,
        tool_input: ev.toolInput,
        agent_type: ev.agentType,
      });
    try {
      diary.record({
        at: t,
        kind: ledgerKind,
        project: ev.project,
        tool: ev.toolName,
        detail,
        sessionId: ev.sessionId,
      });
    } catch {
      /* record() promises not to throw; a pet who cannot write her diary still talks */
    }
  }

  /**
   * Ask the brain, then show its line — or, for a non-urgent kind that got
   * nothing back, the canned line it was standing in for. `seq` is the emitted-
   * line count at the moment the request was fired: if it has moved, another
   * event has taken the bubble since and this reply is about old news.
   */
  async function awaitBrain({ kind, ev, summary, canned, seq, urgent, level, narration }) {
    let line = null;
    try {
      line = await askBrain.requestLine({ detail: brainDetail(ev, kind, narration), summary });
    } catch {
      line = null; // requestLine promises never to reject; belt and braces
    }
    if (shownCount !== seq) return { spoken: false, reason: 'stale', kind, summary };
    if (line) return show(kind, line, ev, summary, { fromTable: false, level, replacing: urgent });
    // Urgent kinds already showed their canned line; do not repeat it.
    if (urgent) return { spoken: false, reason: 'brain-empty', kind, summary };
    return show(kind, canned, ev, summary, { level });
  }

  /**
   * Feed one normalized-or-raw event. Returns a descriptor:
   * {spoken, reason: 'no-trigger'|'muted'|'throttled'|'spoken'|'brain-pending', kind, ...}
   *
   * With a brain configured the descriptor also carries `pending`, a promise of
   * the descriptor for whatever the brain path ends up showing.
   */
  function notify(input = {}) {
    const ev = normalizeEvent(input);
    const t = now();
    const kind = decideTrigger(ev);
    // The streak is the event's, not the line's: a failure she stays quiet about
    // still counts towards the third and fifth, which she does not. Only a
    // successful *completion* clears it — see `succeeded`.
    if (kind === 'failed') failStreak += 1;
    else if (succeeded(ev)) failStreak = 0;
    const patterns = trackPatterns(ev, t);

    if (!kind) return { spoken: false, reason: 'no-trigger', kind: null };
    if (muted()) return { spoken: false, reason: 'muted', kind };

    const salience = salienceOf({
      kind,
      failStreak,
      quietForMs: lastSpokeAt === null ? Infinity : t - lastSpokeAt,
      sinceNotableMs: lastNotableAt === null ? Infinity : t - lastNotableAt,
      patterns,
    });
    if (!salience.level) {
      return { spoken: false, reason: 'not-salient', kind, salience: salience.reason };
    }
    const level = salience.level;

    remember(ev, kind, level, salience.reason, t);

    const wait = waitFor(level, kind, t);
    if (wait > 0) return { spoken: false, reason: 'throttled', kind, retryInMs: wait };

    // Marked here rather than on the way out: a pattern she decided to remark on
    // has been spent whether or not the brain ever answers about it.
    if (level === 'notable') lastNotableAt = t;

    // Captured before anything is shown — for an urgent kind the canned line
    // lands first and would otherwise make every line look like a continuation.
    const narration = {
      memory: mentionMemory,
      now: t,
      firstLine: lastSpokeAt === null || t - lastSpokeAt >= QUIET_STRETCH_MS,
    };

    const summary = buildSummary(ev);
    const canned = messageFor(kind, {
      tool: ev.toolName,
      project: ev.project,
      random,
      avoid: avoidFor(kind),
      persona,
    });

    if (!askBrain) return show(kind, canned, ev, summary, { level });

    // `waiting` and `failed` are the whole point of the pet: they show at once,
    // at the old latency, and a better line only replaces them if one arrives.
    // Everything else can afford to wait for the brain before showing anything,
    // which avoids a visible flip from canned to generated on every event.
    const urgent = INTERRUPT_KINDS.has(kind);
    const first = urgent ? show(kind, canned, ev, summary, { level }) : null;
    const pending = awaitBrain({ kind, ev, summary, canned, seq: shownCount, urgent, level, narration });
    return urgent
      ? { ...first, pending }
      : { spoken: false, reason: 'brain-pending', kind, summary, pending };
  }

  return {
    notify,
    /** Alias — module A probes for `onEvent` first and calls it with the event object. */
    onEvent: notify,
    /**
     * Convenience for a raw hook payload: handleEvent('claude', payload[, mode]).
     * Also tolerates being handed a single event object (same shape as notify).
     */
    handleEvent(source, payload, mode) {
      if (source && typeof source === 'object') return notify(source);
      return notify({ source, payload, ...(mode ? { mode } : {}) });
    },
    /** Introspection for tests and debugging. */
    stats() {
      return { lastSpokeAt, lastMode, lastKind, failStreak, lastNotableAt, holding: Boolean(held) };
    },
    dispose() {
      dropHold(); // never leave a timer holding a line nobody will ever see
      toolClasses.clear();
      recentLines.length = 0;
      trail.length = 0;
      failStreak = 0;
    },
  };
}

export default createSpeech;
