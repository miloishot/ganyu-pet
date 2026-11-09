#!/usr/bin/env node
// ganyu-pet — hook installer.
//
// Appends the ganyu-pet hook forwarder to the codex hooks file and the Claude
// Code settings file. Append-only: existing entries (Orca, Superset, gates …)
// are never removed, reordered or rewritten.
//
//   node hooks/install-hooks.mjs                 dry run (default) — prints a diff
//   node hooks/install-hooks.mjs --apply         writes, after a .bak-ganyu-N backup
//   node hooks/install-hooks.mjs --codex-file <p> --claude-file <p>
//   node hooks/install-hooks.mjs --hook-path <p> --no-codex --no-claude --quiet
//
// Dependency-free (node 22 built-ins only) and importable: `run()` performs no
// writes unless `--apply` is passed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The forwarder every installed hook entry invokes. */
export const HOOK_CMD_PATH = path.join(HERE, 'ganyu-hook.cmd');
const HOOK_BASENAME = 'ganyu-hook.cmd';

export const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
];

export const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
];

/** Claude events that require an explicit tool matcher. */
const CLAUDE_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/** Seconds. The forwarder itself caps out at ~1.5s; this is the outer belt. */
const HOOK_TIMEOUT = 5;

/** The OpenCode plugin the opencode target copies into `<config dir>/plugins/`. */
export const OPENCODE_PLUGIN_PATH = path.join(HERE, 'opencode', 'ganyu.js');
const OPENCODE_PLUGIN_NAME = 'ganyu.js';

// ---------------------------------------------------------------------------
// command strings
// ---------------------------------------------------------------------------

/** Absolute Windows-style path (backslashes), stable across shells. */
export function winPath(p) {
  return path.resolve(p).replaceAll('/', '\\');
}

/** codex invokes the command directly; quoted so a spaced path still works. */
export function codexCommand(hookPath = HOOK_CMD_PATH) {
  return `"${winPath(hookPath)}" codex`;
}

/**
 * Claude Code runs hook commands through bash on Windows, so mirror the shape
 * Orca uses there: forward slashes, single quotes, and a `cat` fallback that
 * drains stdin if the forwarder has been moved or deleted.
 */
export function claudeCommand(hookPath = HOOK_CMD_PATH) {
  const p = winPath(hookPath).replaceAll('\\', '/');
  return `if [ -f '${p}' ]; then '${p}' claude; else cat >/dev/null 2>&1 || :; fi`;
}

function buildGroup(kind, event, command) {
  const group = {};
  if (kind === 'claude' && CLAUDE_MATCHER_EVENTS.has(event)) group.matcher = '*';
  group.hooks = [{ type: 'command', command, timeout: HOOK_TIMEOUT }];
  return group;
}

// ---------------------------------------------------------------------------
// default targets
// ---------------------------------------------------------------------------

export function defaultCodexFile(env = process.env) {
  const home = env.CODEX_HOME ? env.CODEX_HOME : path.join(os.homedir(), '.codex');
  return path.join(home, 'hooks.json');
}

export function defaultClaudeFile() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * OpenCode 1.18 reads its global config from `$XDG_CONFIG_HOME/opencode`, else
 * `<home>/.config/opencode` — on Windows too (no %APPDATA% branch).
 */
export function defaultOpencodeDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

/** `<config dir>/plugins/ganyu.js`, after checking the config dir is sane. Throws otherwise. */
export function opencodeTargetFile(configDir) {
  const kind = (p) => {
    try {
      const st = fs.statSync(p);
      return st.isDirectory() ? 'dir' : 'file';
    } catch {
      return 'missing';
    }
  };
  if (kind(configDir) === 'missing') {
    throw new Error(`${configDir}: OpenCode config dir not found. Is OpenCode installed? Pass --opencode-dir <path>. Nothing written.`);
  }
  if (kind(configDir) !== 'dir') {
    throw new Error(`${configDir}: expected the OpenCode config directory, found a file. Refusing to touch it.`);
  }
  const plugins = path.join(configDir, 'plugins');
  if (kind(plugins) === 'file') {
    throw new Error(`${plugins}: expected a directory, found a file. Refusing to touch it.`);
  }
  const file = path.join(plugins, OPENCODE_PLUGIN_NAME);
  if (kind(file) === 'dir') {
    throw new Error(`${file}: is a directory, not a plugin file. Refusing to touch it.`);
  }
  return file;
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function readTarget(file) {
  if (!fs.existsSync(file)) return { exists: false, text: '', json: {} };
  const text = fs.readFileSync(file, 'utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err.message}). Refusing to touch it.`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${file}: expected a JSON object at the top level.`);
  }
  return { exists: true, text, json };
}

/** Serialize using the indentation / EOL / trailing-newline style of `text`. */
function serializeLike(value, text) {
  const indentMatch = text.match(/\n([ \t]+)"/);
  const indent = indentMatch ? indentMatch[1] : '  ';
  let out = JSON.stringify(value, null, indent);
  if (text === '' || text.endsWith('\n')) out += '\n';
  if (text.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
  return out;
}

function commandsOf(groups) {
  const out = [];
  for (const group of groups) {
    const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
    for (const hook of hooks) {
      if (hook && typeof hook.command === 'string') out.push(hook.command);
    }
  }
  return out;
}

/**
 * Plan the merge for one target file. Pure: reads the file, returns what would
 * be written. Never writes.
 */
export function planTarget({ kind, file, hookPath = HOOK_CMD_PATH, pluginPath = OPENCODE_PLUGIN_PATH }) {
  if (kind === 'opencode') return planOpencode({ file, pluginPath });
  const { exists, text, json } = readTarget(file);
  const before = json;
  const next = clone(before);

  if (next.hooks === undefined || next.hooks === null) next.hooks = {};
  if (typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
    throw new Error(`${file}: "hooks" is not an object. Refusing to touch it.`);
  }

  const events = kind === 'codex' ? CODEX_EVENTS : CLAUDE_EVENTS;
  const command = kind === 'codex' ? codexCommand(hookPath) : claudeCommand(hookPath);

  const added = [];
  const skipped = [];
  const createdEvents = [];
  const warnings = [];

  for (const event of events) {
    if (next.hooks[event] === undefined || next.hooks[event] === null) {
      next.hooks[event] = [];
      createdEvents.push(event);
    }
    const groups = next.hooks[event];
    if (!Array.isArray(groups)) {
      warnings.push(`${event}: expected an array of hook groups, found ${typeof groups} — left untouched`);
      continue;
    }
    const existing = commandsOf(groups);
    if (existing.some((c) => c.trim() === command.trim())) {
      skipped.push(event);
      continue;
    }
    for (const c of existing) {
      if (c.includes(HOOK_BASENAME)) {
        warnings.push(`${event}: an existing entry already references ${HOOK_BASENAME} with a different path or source — adding ours anyway, remove the stale one by hand`);
      }
    }
    groups.push(buildGroup(kind, event, command));
    added.push(event);
  }

  const changed = added.length > 0;
  // Nothing to add → propose the file exactly as it is, so --apply is a no-op
  // and we never reformat somebody else's file for free.
  const nextJson = changed ? next : before;
  const nextText = changed ? serializeLike(next, text) : text;

  if (changed) validatePlan({ file, before, next, nextText });

  return {
    kind,
    file,
    exists,
    command,
    added,
    skipped,
    createdEvents,
    warnings,
    changed,
    beforeText: text,
    nextText,
    nextJson,
  };
}

/**
 * The opencode target is one whole file, not a JSON merge: the plan is "make
 * `<config dir>/plugins/ganyu.js` byte-identical to hooks/opencode/ganyu.js".
 * Only that one file is ever read or written; sibling plugins are not opened.
 */
function planOpencode({ file, pluginPath }) {
  const nextText = fs.readFileSync(pluginPath, 'utf8');
  const exists = fs.existsSync(file);
  const beforeText = exists ? fs.readFileSync(file, 'utf8') : '';
  const changed = beforeText !== nextText;
  const warnings = exists && changed
    ? [`${file} differs from ${pluginPath} — it will be backed up, then replaced`]
    : [];
  if (changed) validatePlan({ kind: 'opencode', file, nextText, source: pluginPath });
  return {
    kind: 'opencode',
    file,
    exists,
    command: `copy ${pluginPath}`,
    added: changed ? [OPENCODE_PLUGIN_NAME] : [],
    skipped: changed ? [] : [OPENCODE_PLUGIN_NAME],
    createdEvents: [],
    warnings,
    changed,
    beforeText,
    nextText,
    nextJson: null,
  };
}

/** Round-trip + append-only assertions. Throws instead of returning false. */
export function validatePlan({ kind, file, before, next, nextText, source }) {
  if (kind === 'opencode') {
    if (path.basename(file) !== OPENCODE_PLUGIN_NAME || path.basename(path.dirname(file)) !== 'plugins') {
      throw new Error(`${file}: the opencode target must be plugins/${OPENCODE_PLUGIN_NAME}. Aborting.`);
    }
    if (nextText !== fs.readFileSync(source, 'utf8')) {
      throw new Error(`${file}: planned bytes differ from ${source}. Aborting.`);
    }
    if (!/export const GanyuPlugin\b/.test(nextText)) {
      throw new Error(`${source}: does not look like the ganyu OpenCode plugin. Aborting.`);
    }
    return true;
  }
  let reparsed;
  try {
    reparsed = JSON.parse(nextText);
  } catch (err) {
    throw new Error(`${file}: generated JSON does not parse (${err.message}). Aborting.`);
  }
  if (!same(reparsed, next)) {
    throw new Error(`${file}: round-trip mismatch between the plan and its serialization. Aborting.`);
  }

  for (const [key, value] of Object.entries(before)) {
    if (key === 'hooks') continue;
    if (!same(next[key], value)) {
      throw new Error(`${file}: top-level key "${key}" would change. Aborting.`);
    }
  }

  const beforeHooks = before.hooks && typeof before.hooks === 'object' && !Array.isArray(before.hooks)
    ? before.hooks
    : {};
  for (const [event, groups] of Object.entries(beforeHooks)) {
    const after = next.hooks[event];
    if (!Array.isArray(groups)) {
      if (!same(after, groups)) throw new Error(`${file}: non-array "${event}" would change. Aborting.`);
      continue;
    }
    if (!Array.isArray(after) || after.length < groups.length) {
      throw new Error(`${file}: "${event}" would lose entries. Aborting.`);
    }
    for (let i = 0; i < groups.length; i++) {
      if (!same(after[i], groups[i])) {
        throw new Error(`${file}: existing "${event}" entry #${i} would be modified or reordered. Aborting.`);
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// diff preview
// ---------------------------------------------------------------------------

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: ' ', line: a[i++], j: j++ });
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) ops.push({ t: '-', line: a[i++] });
    else ops.push({ t: '+', line: b[j++] });
  }
  while (i < n) ops.push({ t: '-', line: a[i++] });
  while (j < m) ops.push({ t: '+', line: b[j++] });
  return ops;
}

/** Minimal unified diff. Enough to eyeball before --apply. */
export function unifiedDiff(beforeText, afterText, label, context = 3) {
  if (beforeText === afterText) return '';
  const a = beforeText.split('\n');
  const b = afterText.split('\n');
  const ops = lcsOps(a, b);

  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });

  const lines = [`--- ${label}`, `+++ ${label} (proposed)`];
  let aLine = 0;
  let bLine = 0;
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].t !== '+') aLine++;
      if (ops[idx].t !== '-') bLine++;
      idx++;
      continue;
    }
    const startA = aLine;
    const startB = bLine;
    const hunk = [];
    let countA = 0;
    let countB = 0;
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx++];
      hunk.push(op.t + op.line);
      if (op.t !== '+') { aLine++; countA++; }
      if (op.t !== '-') { bLine++; countB++; }
    }
    lines.push(`@@ -${startA + 1},${countA} +${startB + 1},${countB} @@`);
    lines.push(...hunk);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

export function nextBackupPath(file) {
  let n = 1;
  while (fs.existsSync(`${file}.bak-ganyu-${n}`)) n++;
  return `${file}.bak-ganyu-${n}`;
}

function applyPlan(plan) {
  let backup = null;
  if (plan.exists) {
    backup = nextBackupPath(plan.file);
    fs.copyFileSync(plan.file, backup);
  } else {
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  }
  fs.writeFileSync(plan.file, plan.nextText, 'utf8');
  // Read back (and, for JSON targets, parse) what actually landed on disk.
  const written = fs.readFileSync(plan.file, 'utf8');
  if (plan.kind !== 'opencode') JSON.parse(written);
  if (written !== plan.nextText) {
    throw new Error(`${plan.file}: written bytes differ from the plan.`);
  }
  return backup;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `ganyu-pet hook installer (dry run unless --apply)

  node hooks/install-hooks.mjs [options]

  --apply              write the changes (backs up to <file>.bak-ganyu-N first)
  --codex-file <path>  override the codex hooks.json target
  --claude-file <path> override the Claude settings.json target
  --hook-path <path>   override the ganyu-hook.cmd path written into the configs
  --no-codex           skip the codex target
  --no-claude          skip the Claude target
  --opencode           also install the OpenCode plugin (opt-in) into
                       $XDG_CONFIG_HOME/opencode, else ~/.config/opencode
  --opencode-dir <dir> the OpenCode config dir to install into (implies --opencode)
  --quiet              summary only, no diff
  -h, --help           this text
`;

export function parseArgs(argv = []) {
  const opts = {
    apply: false,
    quiet: false,
    help: false,
    codexFile: null,
    claudeFile: null,
    hookPath: HOOK_CMD_PATH,
    codex: true,
    claude: true,
    opencode: false,
    opencodeDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--apply': opts.apply = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      case '--codex-file': opts.codexFile = value(); break;
      case '--claude-file': opts.claudeFile = value(); break;
      case '--hook-path': opts.hookPath = value(); break;
      case '--no-codex': opts.codex = false; break;
      case '--no-claude': opts.claude = false; break;
      case '--opencode': opts.opencode = true; break;
      case '--opencode-dir': opts.opencodeDir = value(); opts.opencode = true; break;
      default: throw new Error(`unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return opts;
}

/**
 * Plan both targets, validate both, then (only with --apply) write both.
 * Returns { applied, dryRun, plans, backups }.
 */
export function run(argv = [], { log = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return { help: true, applied: false, dryRun: true, plans: [], backups: {} };
  }

  const targets = [];
  if (opts.codex) targets.push({ kind: 'codex', file: opts.codexFile ?? defaultCodexFile() });
  if (opts.claude) targets.push({ kind: 'claude', file: opts.claudeFile ?? defaultClaudeFile() });
  if (opts.opencode) {
    targets.push({ kind: 'opencode', file: opencodeTargetFile(opts.opencodeDir ?? defaultOpencodeDir()) });
  }

  // Plan and validate everything before touching anything.
  const plans = targets.map((t) => planTarget({ ...t, hookPath: opts.hookPath }));

  const backups = {};
  if (opts.apply) {
    for (const plan of plans) {
      if (plan.changed) backups[plan.file] = applyPlan(plan);
    }
  }

  for (const plan of plans) {
    const head = `${plan.kind}: ${plan.file}`;
    if (!plan.exists) log(`${head}\n  (does not exist — would be created)`);
    else log(head);
    log(`  command: ${plan.command}`);
    log(`  add: ${plan.added.length ? plan.added.join(', ') : '(none)'}`);
    log(`  already present: ${plan.skipped.length ? plan.skipped.join(', ') : '(none)'}`);
    for (const w of plan.warnings) log(`  warning: ${w}`);
    if (opts.apply) {
      log(plan.changed
        ? `  WROTE — backup: ${backups[plan.file] ?? '(new file, nothing to back up)'}`
        : '  unchanged (nothing to add)');
    } else if (plan.changed) {
      if (!opts.quiet) log(unifiedDiff(plan.beforeText, plan.nextText, plan.file));
      log('  DRY RUN — nothing written. Re-run with --apply.');
    } else {
      log('  already installed — nothing to do.');
    }
  }

  return { applied: opts.apply, dryRun: !opts.apply, plans, backups };
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(`install-hooks: ${err.message}`);
    process.exit(1);
  }
}
