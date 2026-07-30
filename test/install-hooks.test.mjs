// Success criterion 5: the installer merges into fixture copies of hooks.json /
// settings.json, preserves every pre-existing entry, adds ours exactly once, is
// idempotent, and never touches real config without --apply.
//
// Every test operates on copies inside hooks/fixtures/.work-*; the real
// ~/.codex/hooks.json and ~/.claude/settings.json are asserted untouched at the
// end of the file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  run,
  planTarget,
  parseArgs,
  unifiedDiff,
  codexCommand,
  claudeCommand,
  CODEX_EVENTS,
  CLAUDE_EVENTS,
  HOOK_CMD_PATH,
} from '../hooks/install-hooks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const FIXTURES = path.join(REPO, 'hooks', 'fixtures');
const INSTALLER = path.join(REPO, 'hooks', 'install-hooks.mjs');

const REAL_TARGETS = [
  path.join(os.homedir(), '.codex', 'hooks.json'),
  path.join(os.homedir(), '.claude', 'settings.json'),
];
const realBefore = REAL_TARGETS.map((f) => ({
  file: f,
  stat: fs.existsSync(f) ? fs.statSync(f) : null,
}));
const fixtureBefore = fs.readdirSync(FIXTURES)
  .filter((n) => n.endsWith('.json'))
  .map((n) => ({ n, text: fs.readFileSync(path.join(FIXTURES, n), 'utf8') }));

const silent = { log: () => {} };
let counter = 0;

function workspace(t) {
  const dir = path.join(FIXTURES, `.work-${process.pid}-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    copy(name, as = name) {
      const dest = path.join(dir, as);
      fs.copyFileSync(path.join(FIXTURES, name), dest);
      return dest;
    },
    write(name, text) {
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, text, 'utf8');
      return dest;
    },
    backups() {
      return fs.readdirSync(dir).filter((n) => n.includes('.bak-ganyu-'));
    },
  };
}

const read = (f) => fs.readFileSync(f, 'utf8');
const parse = (f) => JSON.parse(read(f));

/** Every command string in the file, in document order. */
function allCommands(json) {
  const out = [];
  for (const groups of Object.values(json.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group?.hooks ?? []) {
        if (typeof hook?.command === 'string') out.push(hook.command);
      }
    }
  }
  return out;
}

function countIn(json, event, command) {
  const groups = json.hooks?.[event] ?? [];
  let n = 0;
  for (const group of groups) {
    for (const hook of group?.hooks ?? []) if (hook?.command === command) n++;
  }
  return n;
}

/** Append-only: the pre-existing group array must still be a prefix. */
function assertPrefixPreserved(before, after) {
  for (const [event, groups] of Object.entries(before.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const now = after.hooks[event];
    assert.ok(Array.isArray(now), `${event} disappeared`);
    assert.ok(now.length >= groups.length, `${event} lost entries`);
    for (let i = 0; i < groups.length; i++) {
      assert.deepEqual(now[i], groups[i], `${event} entry #${i} changed or moved`);
    }
  }
}

test('the forwarder exists and both command strings point at it', () => {
  assert.ok(fs.existsSync(HOOK_CMD_PATH), 'hooks/ganyu-hook.cmd is missing');
  assert.match(codexCommand(), /ganyu-hook\.cmd" codex$/);
  assert.match(claudeCommand(), /ganyu-hook\.cmd' claude;/);
  // Claude's variant must still drain stdin if the forwarder is gone.
  assert.match(claudeCommand(), /cat >\/dev\/null/);
});

test('dry run is the default: nothing is written, nothing is backed up', (t) => {
  const ws = workspace(t);
  const codex = ws.copy('codex-hooks.json');
  const claude = ws.copy('claude-settings.json');
  const codexBefore = read(codex);
  const claudeBefore = read(claude);

  const res = run(['--codex-file', codex, '--claude-file', claude], silent);

  assert.equal(res.applied, false);
  assert.equal(res.dryRun, true);
  assert.equal(read(codex), codexBefore, 'codex fixture copy was modified');
  assert.equal(read(claude), claudeBefore, 'claude fixture copy was modified');
  assert.deepEqual(ws.backups(), []);

  // The plan is complete and its proposal is valid JSON.
  const [codexPlan, claudePlan] = res.plans;
  assert.deepEqual(codexPlan.added, CODEX_EVENTS);
  assert.deepEqual(claudePlan.added, CLAUDE_EVENTS);
  assert.doesNotThrow(() => JSON.parse(codexPlan.nextText));
  assert.doesNotThrow(() => JSON.parse(claudePlan.nextText));
});

test('dry run prints a unified-diff preview that only adds lines', (t) => {
  const ws = workspace(t);
  const codex = ws.copy('codex-hooks.json');
  const plan = planTarget({ kind: 'codex', file: codex });
  const diff = unifiedDiff(plan.beforeText, plan.nextText, codex);

  assert.match(diff, /^--- /);
  assert.match(diff, /\n@@ /);
  const removals = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
  assert.deepEqual(removals, [], 'the diff removes lines — merge is not append-only');
  assert.ok(diff.includes('ganyu-hook.cmd'), 'diff does not show our command');
});

test('--apply merges into codex hooks.json: preserves Orca + Superset, adds ours once', (t) => {
  const ws = workspace(t);
  const codex = ws.copy('codex-hooks.json');
  const before = parse(codex);
  const beforeCommands = allCommands(before);

  const res = run(['--apply', '--codex-file', codex, '--no-claude'], silent);
  assert.equal(res.applied, true);

  const after = parse(codex);
  assertPrefixPreserved(before, after);

  const afterCommands = allCommands(after);
  for (const c of beforeCommands) {
    assert.ok(afterCommands.includes(c), `pre-existing command lost: ${c}`);
  }
  assert.equal(
    afterCommands.filter((c) => c.includes('orca')).length,
    beforeCommands.filter((c) => c.includes('orca')).length,
  );
  assert.equal(
    afterCommands.filter((c) => c.includes('superset')).length,
    beforeCommands.filter((c) => c.includes('superset')).length,
  );

  const cmd = codexCommand(HOOK_CMD_PATH);
  for (const event of CODEX_EVENTS) {
    assert.equal(countIn(after, event, cmd), 1, `${event} should carry our command exactly once`);
    const ours = after.hooks[event].at(-1);
    assert.equal(ours.matcher, undefined, 'codex entries carry no matcher');
    assert.equal(ours.hooks[0].type, 'command');
    assert.equal(typeof ours.hooks[0].timeout, 'number');
  }

  assert.deepEqual(ws.backups(), ['codex-hooks.json.bak-ganyu-1']);
  assert.deepEqual(
    JSON.parse(read(path.join(ws.dir, 'codex-hooks.json.bak-ganyu-1'))),
    before,
    'backup is not a faithful copy of the original',
  );
});

test('--apply merges into Claude settings.json: matchers, new events, other keys intact', (t) => {
  const ws = workspace(t);
  const claude = ws.copy('claude-settings.json');
  const before = parse(claude);

  run(['--apply', '--claude-file', claude, '--no-codex'], silent);
  const after = parse(claude);

  assertPrefixPreserved(before, after);

  // Non-hook settings survive verbatim.
  for (const key of Object.keys(before)) {
    if (key === 'hooks') continue;
    assert.deepEqual(after[key], before[key], `top-level "${key}" changed`);
  }
  // Hook events we do not target survive verbatim.
  for (const event of ['StopFailure', 'SubagentStart', 'PermissionRequest']) {
    assert.deepEqual(after.hooks[event], before.hooks[event], `${event} changed`);
  }
  // A non-command hook type survives.
  assert.ok(allCommands(before).length > 0);
  assert.deepEqual(
    after.hooks.PreToolUse.find((g) => g.matcher === 'Edit|Write|NotebookEdit'),
    before.hooks.PreToolUse.find((g) => g.matcher === 'Edit|Write|NotebookEdit'),
  );

  const cmd = claudeCommand(HOOK_CMD_PATH);
  for (const event of CLAUDE_EVENTS) {
    assert.equal(countIn(after, event, cmd), 1, `${event} should carry our command exactly once`);
    const ours = after.hooks[event].find((g) => g.hooks.some((h) => h.command === cmd));
    const expectMatcher = event === 'PreToolUse' || event === 'PostToolUse';
    assert.equal(ours.matcher, expectMatcher ? '*' : undefined, `${event} matcher`);
  }

  // Events absent from the fixture are created.
  assert.equal(before.hooks.Notification, undefined);
  assert.equal(before.hooks.SessionEnd, undefined);
  assert.equal(after.hooks.Notification.length, 1);
  assert.equal(after.hooks.SessionEnd.length, 1);
});

test('re-running --apply is idempotent: no duplicates, no rewrite, no second backup', (t) => {
  const ws = workspace(t);
  const codex = ws.copy('codex-hooks.json');
  const claude = ws.copy('claude-settings.json');

  run(['--apply', '--codex-file', codex, '--claude-file', claude], silent);
  const afterFirstCodex = read(codex);
  const afterFirstClaude = read(claude);
  const backupsAfterFirst = ws.backups().sort();

  const second = run(['--apply', '--codex-file', codex, '--claude-file', claude], silent);

  for (const plan of second.plans) {
    assert.deepEqual(plan.added, [], `${plan.kind}: second run added entries`);
    assert.equal(plan.changed, false, `${plan.kind}: second run reported a change`);
  }
  assert.deepEqual(second.plans[0].skipped, CODEX_EVENTS);
  assert.deepEqual(second.plans[1].skipped, CLAUDE_EVENTS);
  assert.equal(read(codex), afterFirstCodex, 'codex file rewritten on re-run');
  assert.equal(read(claude), afterFirstClaude, 'claude file rewritten on re-run');
  assert.deepEqual(ws.backups().sort(), backupsAfterFirst, 'a redundant backup was created');

  // Third run, dry: still nothing to do.
  const third = run(['--codex-file', codex, '--claude-file', claude], silent);
  assert.deepEqual(third.plans.map((p) => p.added), [[], []]);
});

test('Claude settings without a hooks key gets one, keeping every other setting', (t) => {
  const ws = workspace(t);
  const claude = ws.copy('claude-settings-no-hooks.json');
  const before = parse(claude);
  assert.equal(before.hooks, undefined);

  run(['--apply', '--claude-file', claude, '--no-codex'], silent);
  const after = parse(claude);

  assert.deepEqual(Object.keys(after.hooks), CLAUDE_EVENTS);
  for (const key of Object.keys(before)) {
    assert.deepEqual(after[key], before[key], `top-level "${key}" changed`);
  }
  const cmd = claudeCommand(HOOK_CMD_PATH);
  for (const event of CLAUDE_EVENTS) assert.equal(countIn(after, event, cmd), 1);
});

test('malformed target aborts before anything is written', (t) => {
  const ws = workspace(t);
  const broken = ws.write('broken-settings.json', '{ "hooks": { "Stop": [ }\n');
  const codex = ws.copy('codex-hooks.json');
  const codexBefore = read(codex);
  const brokenBefore = read(broken);

  assert.throws(
    () => run(['--apply', '--codex-file', codex, '--claude-file', broken], silent),
    /not valid JSON/,
  );
  assert.equal(read(broken), brokenBefore, 'malformed file was touched');
  assert.equal(read(codex), codexBefore, 'the healthy target was written despite the abort');
  assert.deepEqual(ws.backups(), []);
});

test('a non-object hooks value is refused rather than replaced', (t) => {
  const ws = workspace(t);
  const bad = ws.write('array-hooks.json', '{\n  "hooks": []\n}\n');
  assert.throws(() => run(['--apply', '--claude-file', bad, '--no-codex'], silent), /"hooks" is not an object/);
  assert.equal(read(bad), '{\n  "hooks": []\n}\n');
});

test('the merged file keeps the original indentation and trailing-newline style', (t) => {
  const ws = workspace(t);
  const codex = ws.copy('codex-hooks.json');
  const hadTrailing = read(codex).endsWith('\n');
  run(['--apply', '--codex-file', codex, '--no-claude'], silent);
  const after = read(codex);
  assert.equal(after.endsWith('\n'), hadTrailing);
  assert.ok(after.includes('\n  "hooks"'), 'indentation changed');
  assert.ok(!after.includes('\r\n'), 'line endings changed');
});

test('CLI: bare invocation is a dry run and exits 0', (t) => {
  const ws = workspace(t);
  const codex = ws.copy('codex-hooks.json');
  const claude = ws.copy('claude-settings.json');
  const codexBefore = read(codex);
  const claudeBefore = read(claude);

  const out = execFileSync(
    process.execPath,
    [INSTALLER, '--codex-file', codex, '--claude-file', claude],
    { encoding: 'utf8' },
  );

  assert.match(out, /DRY RUN/);
  assert.match(out, /ganyu-hook\.cmd/);
  assert.equal(read(codex), codexBefore);
  assert.equal(read(claude), claudeBefore);
  assert.deepEqual(ws.backups(), []);
});

test('CLI: unknown option fails loudly without writing', (t) => {
  const ws = workspace(t);
  const codex = ws.copy('codex-hooks.json');
  const before = read(codex);
  assert.throws(() => execFileSync(
    process.execPath,
    [INSTALLER, '--codex-file', codex, '--wipe-everything'],
    { encoding: 'utf8', stdio: 'pipe' },
  ));
  assert.equal(read(codex), before);
});

test('parseArgs defaults to dry run and both targets', () => {
  const opts = parseArgs([]);
  assert.equal(opts.apply, false);
  assert.equal(opts.codex, true);
  assert.equal(opts.claude, true);
  assert.equal(opts.hookPath, HOOK_CMD_PATH);
  assert.equal(parseArgs(['--apply']).apply, true);
});

test('real config files and fixtures were never touched by this suite', () => {
  for (const { file, stat } of realBefore) {
    if (stat === null) {
      assert.equal(fs.existsSync(file), false, `${file} was created by the tests`);
      continue;
    }
    const now = fs.statSync(file);
    assert.equal(now.size, stat.size, `${file} size changed`);
    assert.equal(now.mtimeMs, stat.mtimeMs, `${file} mtime changed`);
    assert.equal(fs.existsSync(`${file}.bak-ganyu-1`), false, `${file}.bak-ganyu-1 was created`);
  }
  for (const { n, text } of fixtureBefore) {
    assert.equal(read(path.join(FIXTURES, n)), text, `fixture ${n} was modified`);
  }
});
