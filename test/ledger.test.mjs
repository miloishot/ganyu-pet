// Ledger tests — what she remembers, and what she must never write down.
//
// `fs` is injected, so nothing here touches a real disk: the fake below is a
// Map of path -> text with a fault switch, which is also the only way to test
// the interesting half of the prune (the half where the rename fails). Three
// themes run through the file:
//   1. durability — a truncated line, a missing file, a missing directory and a
//      failed prune all have to yield *less*, never an exception and never a
//      lost ledger;
//   2. privacy — the entry is rebuilt from six named fields, so the keys that
//      carry the owner's work cannot reach the disk even when handed over;
//   3. recall — the digest is the whole point, and it has to stay short.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_ENTRIES,
  DIGEST_WINDOW_MS,
  ENTRY_KEYS,
  LEDGER_KINDS,
  MAX_DETAIL_CHARS,
  MAX_DIGEST_CHARS,
  createLedger,
  describeAgo,
  describeSpan,
  sanitizeEntry,
} from '../src/main/ledger.mjs';

const FILE = 'C:\\Users\\kw11l\\Desktop\\ganyu-pet\\.ganyu\\ledger.jsonl';
const DIR = 'C:\\Users\\kw11l\\Desktop\\ganyu-pet\\.ganyu';
const TEMP = `${FILE}.tmp`;
const MIN = 60_000;
const HOUR = 60 * MIN;
// Local, so the daypart phrasing is TZ-proof wherever this runs.
const NOW = new Date(2026, 6, 30, 23, 30).getTime();

/**
 * node:fs, shrunk to the calls ledger.mjs makes. `fail` names a method that
 * throws — the only way to reach the prune's failure path deliberately.
 * `omit` removes a method entirely, for the platform that has no renameSync.
 */
function fakeFs({ files = {}, fail = {}, omit = [] } = {}) {
  const store = new Map(Object.entries(files));
  const dirs = new Set();
  const calls = [];
  const guard = (name, ...args) => {
    calls.push([name, ...args]);
    if (fail[name]) throw new Error(`${name} refused`);
  };

  const api = {
    store,
    dirs,
    calls,
    fail,
    names: () => calls.map((c) => c[0]),
    text: (p = FILE) => store.get(p) ?? '',
    lines: (p = FILE) => (store.get(p) ?? '').split('\n').filter((l) => l !== ''),
    existsSync(p) {
      calls.push(['existsSync', p]);
      return store.has(p) || dirs.has(p);
    },
    readFileSync(p) {
      guard('readFileSync', p);
      if (!store.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return store.get(p);
    },
    appendFileSync(p, data) {
      guard('appendFileSync', p);
      store.set(p, (store.get(p) ?? '') + data);
    },
    writeFileSync(p, data) {
      guard('writeFileSync', p);
      store.set(p, data);
    },
    mkdirSync(p, opts) {
      guard('mkdirSync', p, opts);
      dirs.add(p);
    },
    renameSync(from, to) {
      guard('renameSync', from, to);
      store.set(to, store.get(from) ?? '');
      store.delete(from);
    },
    unlinkSync(p) {
      guard('unlinkSync', p);
      store.delete(p);
    },
  };
  for (const name of omit) delete api[name];
  return api;
}

/** A ledger over a fake disk, with a clock the test moves by hand. */
function makeLedger({ files, fail, omit, maxEntries, at = NOW } = {}) {
  const fs = fakeFs({ files, fail, omit });
  const clock = { t: at };
  const ledger = createLedger({ filePath: FILE, fs, maxEntries, now: () => clock.t });
  return { ledger, fs, clock };
}

/** One entry as the caller would hand it over. */
const mk = (kind, extra = {}) => ({ kind, project: 'ganyu-pet', sessionId: 's1', ...extra });

/** A file of pre-existing lines, newest last. */
const jsonl = (...entries) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test('the exported shape is frozen and holds no surprises', () => {
  assert.equal(DEFAULT_MAX_ENTRIES, 500);
  assert.equal(DIGEST_WINDOW_MS, 6 * HOUR);
  assert.equal(Object.isFrozen(LEDGER_KINDS), true);
  assert.equal(Object.isFrozen(ENTRY_KEYS), true);
  assert.deepEqual([...ENTRY_KEYS], ['at', 'kind', 'project', 'tool', 'detail', 'sessionId']);
  assert.equal(LEDGER_KINDS.includes('busy'), false, 'routine tool traffic is not a memory');
  assert.deepEqual(
    [...LEDGER_KINDS].sort(),
    ['celebrate', 'failed', 'greeting', 'notable', 'recovered', 'waiting'],
  );
});

// ---------------------------------------------------------------------------
// append and read back
// ---------------------------------------------------------------------------

test('record appends one JSON line per entry and reads it back', () => {
  const { ledger, fs, clock } = makeLedger();

  const stored = ledger.record(mk('failed', { tool: 'Bash', detail: 'running `npm test`' }));
  assert.deepEqual(stored, {
    at: NOW,
    kind: 'failed',
    project: 'ganyu-pet',
    tool: 'Bash',
    detail: 'running `npm test`',
    sessionId: 's1',
  });

  clock.t = NOW + MIN;
  ledger.record(mk('recovered', { tool: 'Bash' }));

  assert.equal(fs.lines().length, 2, 'one line per record');
  assert.equal(fs.text().endsWith('\n'), true, 'every line is terminated');
  assert.deepEqual(
    ledger.recent(10).map((e) => [e.kind, e.at]),
    [['recovered', NOW + MIN], ['failed', NOW]],
    'newest first',
  );
});

test('an explicit at is kept; a missing one is stamped from the injected clock', () => {
  const { ledger, clock } = makeLedger();
  clock.t = 5_000;
  assert.equal(ledger.record(mk('greeting')).at, 5_000);
  assert.equal(ledger.record(mk('greeting', { at: 1_234 })).at, 1_234);
  assert.equal(ledger.record(mk('greeting', { at: 'not a time' })).at, 5_000, 'garbage falls back');
});

test('only the notable kinds are storable; everything else is refused silently', () => {
  const { ledger, fs } = makeLedger();
  const refused = ['busy', 'chat', 'FAILED', '', ' ', null, undefined, 42, 'read'];
  for (const kind of refused) {
    assert.equal(ledger.record({ kind, project: 'ganyu-pet' }), null, `kind ${JSON.stringify(kind)}`);
  }
  for (const bad of [null, undefined, 'failed', 42, [], [{ kind: 'failed' }]]) {
    assert.equal(ledger.record(bad), null, `entry ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.names().includes('appendFileSync'), false, 'a refused entry never reaches the disk');
  assert.deepEqual(ledger.recent(), []);
});

test('a session id, tool or project that is not a string is dropped, not stringified', () => {
  const { ledger } = makeLedger();
  const stored = ledger.record({
    kind: 'waiting',
    project: { name: 'ganyu-pet' },
    tool: ['Bash'],
    sessionId: 12345,
    detail: null,
  });
  assert.deepEqual(stored, { at: NOW, kind: 'waiting' }, 'nothing optional survived');
});

test('reads hand back copies, so a caller cannot edit her memory in place', () => {
  const { ledger } = makeLedger();
  ledger.record(mk('celebrate'));
  const snapshot = ledger.recent();
  snapshot[0].project = 'tampered';
  snapshot.push({ kind: 'failed' });
  assert.equal(ledger.recent()[0].project, 'ganyu-pet');
  assert.equal(ledger.recent().length, 1);
});

// ---------------------------------------------------------------------------
// privacy — the entry is rebuilt, never copied
// ---------------------------------------------------------------------------

test('the keys carrying his actual work never reach the disk', () => {
  const { ledger, fs } = makeLedger();
  const secrets = {
    old_string: 'const apiKey = "sk-live-8f3b2a";',
    new_string: 'const apiKey = process.env.KEY;',
    content: 'the entire file, line by line',
    prompt: 'what the owner actually typed',
    transcript_path: 'C:\\Users\\kw11l\\.claude\\projects\\transcript.jsonl',
    diff: '--- a/index.ts\n+++ b/index.ts',
    env: { ANTHROPIC_API_KEY: 'sk-ant-secret' },
    raw: { tool_input: { content: 'more of it' } },
  };

  const stored = ledger.record({ ...mk('failed', { tool: 'Edit', detail: 'editing index.ts' }), ...secrets });
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'detail', 'kind', 'project', 'sessionId', 'tool']);

  const text = fs.text();
  for (const [key, value] of Object.entries(secrets)) {
    assert.equal(text.includes(key), false, `key ${key} on disk`);
    if (typeof value === 'string') {
      assert.equal(text.includes(value.slice(0, 20)), false, `value of ${key} on disk`);
    }
  }
  assert.equal(text.includes('sk-'), false, 'nothing that looks like a key');
  assert.equal(text.includes('editing index.ts'), true, 'the sayable clause did survive');
});

test('an object smuggled under detail is dropped rather than serialised', () => {
  const { ledger, fs } = makeLedger();
  ledger.record(mk('failed', { detail: { old_string: 'secret', new_string: 'also secret' } }));
  assert.equal(fs.text().includes('secret'), false);
  assert.equal(ledger.recent()[0].detail, undefined);
});

test('an oversized detail is clamped, so even a leak is one short line', () => {
  const { ledger } = makeLedger();
  const diff = 'x'.repeat(4000);
  const stored = ledger.record(mk('failed', { detail: diff }));
  assert.equal(stored.detail.length, MAX_DETAIL_CHARS);
  assert.equal(stored.detail.endsWith('…'), true);
});

test('a detail spanning lines is collapsed to one', () => {
  const { ledger, fs } = makeLedger();
  ledger.record(mk('failed', { detail: 'running\n`npm   test`\n  twice' }));
  assert.equal(ledger.recent()[0].detail, 'running `npm test` twice');
  assert.equal(fs.lines().length, 1, 'still one line on disk');
});

test('the same gate runs on read, so a hand-edited file cannot smuggle a key back', () => {
  const files = {
    [FILE]: `${JSON.stringify({
      at: NOW,
      kind: 'failed',
      project: 'ganyu-pet',
      old_string: 'const secret = 1;',
      content: 'the whole file',
    })}\n`,
  };
  const { ledger } = makeLedger({ files });
  const [entry] = ledger.recent();
  assert.deepEqual(entry, { at: NOW, kind: 'failed', project: 'ganyu-pet' });
});

test('sanitizeEntry is usable on its own and refuses what it cannot date', () => {
  assert.equal(sanitizeEntry({ kind: 'failed' }), null, 'no timestamp anywhere');
  assert.deepEqual(sanitizeEntry({ kind: 'failed' }, 99), { at: 99, kind: 'failed' });
  assert.equal(sanitizeEntry({ kind: 'busy', at: 1 }), null);
  assert.equal(sanitizeEntry(null, 1), null);
});

// ---------------------------------------------------------------------------
// a file written by a process that can be killed mid-write
// ---------------------------------------------------------------------------

test('a truncated final line is skipped and the good ones survive', () => {
  const good = jsonl(
    { at: NOW - 2 * MIN, kind: 'greeting', project: 'ganyu-pet' },
    { at: NOW - MIN, kind: 'failed', project: 'ganyu-pet' },
  );
  const files = { [FILE]: `${good}{"at":${NOW},"kind":"cele` };
  const { ledger } = makeLedger({ files });

  assert.equal(ledger.recent(10).length, 2, 'the half-written tail is skipped, not thrown on');
  assert.deepEqual(ledger.recent(10).map((e) => e.kind), ['failed', 'greeting']);
});

test('garbage lines of every shape are skipped without throwing', () => {
  const files = {
    [FILE]: [
      'not json at all',
      '{"at":1,"kind":}',
      'null',
      '[]',
      '"a bare string"',
      '42',
      '{"kind":"failed"}', // no timestamp
      '',
      '   ',
      JSON.stringify({ at: NOW, kind: 'celebrate', project: 'ganyu-pet' }),
    ].join('\n'),
  };
  const { ledger } = makeLedger({ files });
  assert.deepEqual(ledger.recent(10), [{ at: NOW, kind: 'celebrate', project: 'ganyu-pet' }]);
});

test('CRLF line endings are read the same as LF', () => {
  const files = {
    [FILE]: `${JSON.stringify({ at: NOW - MIN, kind: 'greeting' })}\r\n${JSON.stringify({ at: NOW, kind: 'celebrate' })}\r\n`,
  };
  const { ledger } = makeLedger({ files });
  assert.deepEqual(ledger.recent(10).map((e) => e.kind), ['celebrate', 'greeting']);
});

test('a missing file is an empty ledger, not an error', () => {
  const { ledger, fs } = makeLedger();
  assert.deepEqual(ledger.recent(), []);
  assert.deepEqual(ledger.since(0), []);
  assert.deepEqual(ledger.forProject('ganyu-pet'), []);
  assert.equal(ledger.digest({ now: NOW }), null);
  assert.deepEqual(ledger.stats(), {
    path: FILE,
    enabled: true,
    entries: 0,
    oldest: null,
    newest: null,
    maxEntries: DEFAULT_MAX_ENTRIES,
  });
  assert.equal(fs.names().includes('readFileSync'), false, 'no read attempted on a file that is not there');
});

test('the parent directory is created once, and only when something is written', () => {
  const { ledger, fs } = makeLedger();
  ledger.recent();
  assert.equal(fs.names().includes('mkdirSync'), false, 'a read never creates anything');

  ledger.record(mk('greeting'));
  ledger.record(mk('celebrate'));
  const mkdirs = fs.calls.filter((c) => c[0] === 'mkdirSync');
  assert.equal(mkdirs.length, 1, 'created once, not per write');
  assert.deepEqual(mkdirs[0], ['mkdirSync', DIR, { recursive: true }]);
});

test('a disk that refuses every write returns null and stays readable', () => {
  const files = { [FILE]: jsonl({ at: NOW, kind: 'failed', project: 'ganyu-pet' }) };
  const { ledger } = makeLedger({ files, fail: { appendFileSync: true, mkdirSync: true } });
  assert.equal(ledger.record(mk('celebrate')), null, 'no throw, just null');
  assert.equal(ledger.recent().length, 1, 'what was already written still reads back');
});

test('a read that fails is an empty ledger rather than an exception', () => {
  const files = { [FILE]: jsonl({ at: NOW, kind: 'failed' }) };
  const { ledger } = makeLedger({ files, fail: { readFileSync: true } });
  assert.deepEqual(ledger.recent(), []);
  assert.equal(ledger.digest({ now: NOW }), null);
  assert.equal(ledger.stats().entries, 0);
});

// ---------------------------------------------------------------------------
// pruning
// ---------------------------------------------------------------------------

test('exceeding maxEntries rewrites the file keeping the newest', () => {
  const { ledger, fs, clock } = makeLedger({ maxEntries: 5 });
  for (let i = 1; i <= 7; i += 1) {
    clock.t = NOW + i * MIN;
    ledger.record(mk('celebrate', { detail: `m${i}` }));
  }

  assert.equal(fs.lines().length, 5, 'the file itself is bounded, not just the read');
  assert.deepEqual(ledger.recent(20).map((e) => e.detail), ['m7', 'm6', 'm5', 'm4', 'm3']);
  assert.equal(fs.store.has(TEMP), false, 'the temp file was renamed away, not left behind');
});

test('the prune writes a temp file and renames it over the original', () => {
  const { ledger, fs, clock } = makeLedger({ maxEntries: 3 });
  for (let i = 1; i <= 4; i += 1) {
    clock.t = NOW + i * MIN;
    ledger.record(mk('celebrate', { detail: `m${i}` }));
  }
  const order = fs.names().filter((n) => n === 'writeFileSync' || n === 'renameSync');
  assert.deepEqual(order, ['writeFileSync', 'renameSync'], 'temp first, then the swap');
  assert.deepEqual(fs.calls.find((c) => c[0] === 'writeFileSync').slice(0, 2), ['writeFileSync', TEMP]);
  assert.deepEqual(fs.calls.find((c) => c[0] === 'renameSync').slice(0, 3), ['renameSync', TEMP, FILE]);
});

test('a rename that fails mid-prune leaves the whole original readable', () => {
  const { ledger, fs, clock } = makeLedger({ maxEntries: 5, fail: { renameSync: true } });
  for (let i = 1; i <= 7; i += 1) {
    clock.t = NOW + i * MIN;
    assert.notEqual(ledger.record(mk('celebrate', { detail: `m${i}` })), null, `record ${i}`);
  }

  assert.equal(fs.lines().length, 7, 'the original file was never truncated');
  assert.deepEqual(
    ledger.recent(20).map((e) => e.detail),
    ['m7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1'],
    'nothing was lost — over the cap beats empty',
  );
});

test('a temp write that fails leaves the original untouched too', () => {
  const { ledger, fs, clock } = makeLedger({ maxEntries: 5, fail: { writeFileSync: true } });
  for (let i = 1; i <= 7; i += 1) {
    clock.t = NOW + i * MIN;
    ledger.record(mk('celebrate', { detail: `m${i}` }));
  }
  assert.equal(fs.lines().length, 7);
  assert.equal(ledger.recent(20).length, 7);
  assert.equal(fs.store.has(TEMP), false, 'the temp file never got written');
});

test('a failed prune is retried on the next record rather than abandoned', () => {
  const { ledger, fs, clock } = makeLedger({ maxEntries: 3, fail: { renameSync: true } });
  for (let i = 1; i <= 4; i += 1) {
    clock.t = NOW + i * MIN;
    ledger.record(mk('celebrate', { detail: `m${i}` }));
  }
  assert.equal(fs.names().filter((n) => n === 'renameSync').length, 1);

  delete fs.fail.renameSync; // the disk comes back
  clock.t = NOW + 5 * MIN;
  ledger.record(mk('celebrate', { detail: 'm5' }));
  assert.equal(fs.lines().length, 3, 'the next record prunes');
  assert.deepEqual(ledger.recent(10).map((e) => e.detail), ['m5', 'm4', 'm3']);
});

test('with no renameSync the prune still bounds the file, and clears its temp', () => {
  const { ledger, fs, clock } = makeLedger({ maxEntries: 3, omit: ['renameSync'] });
  for (let i = 1; i <= 5; i += 1) {
    clock.t = NOW + i * MIN;
    ledger.record(mk('celebrate', { detail: `m${i}` }));
  }
  assert.deepEqual(ledger.recent(10).map((e) => e.detail), ['m5', 'm4', 'm3']);
  assert.equal(fs.store.has(TEMP), false, 'temp cleaned up');
});

test('the prune also repairs: corrupt lines do not survive it', () => {
  const seeded = [
    ...[1, 2, 3, 4, 5].map((i) => JSON.stringify({ at: NOW + i, kind: 'celebrate', detail: `old${i}` })),
    '{"at":1,"kind":"cele',
    'not json',
  ].join('\n');
  const { ledger, fs, clock } = makeLedger({ files: { [FILE]: `${seeded}\n` }, maxEntries: 5 });

  clock.t = NOW + 10;
  ledger.record(mk('celebrate', { detail: 'fresh' }));

  assert.equal(fs.lines().length, 5, 'corrupt lines are gone, and the cap holds');
  assert.equal(fs.text().includes('not json'), false);
  assert.deepEqual(ledger.recent(10).map((e) => e.detail), ['fresh', 'old5', 'old4', 'old3', 'old2']);
});

test('a nonsense maxEntries falls back to the default instead of pruning to nothing', () => {
  for (const bad of [0, -3, NaN, 'five', null]) {
    const { ledger } = makeLedger({ maxEntries: bad });
    assert.equal(ledger.stats().maxEntries, DEFAULT_MAX_ENTRIES, `maxEntries=${String(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

/** Six entries an hour apart, two projects, for the read tests. */
function seeded() {
  const files = {
    [FILE]: jsonl(
      { at: NOW - 5 * HOUR, kind: 'greeting', project: 'ganyu-pet' },
      { at: NOW - 4 * HOUR, kind: 'failed', project: 'ganyu-pet', tool: 'Bash' },
      { at: NOW - 3 * HOUR, kind: 'recovered', project: 'ganyu-pet', tool: 'Bash' },
      { at: NOW - 2 * HOUR, kind: 'waiting', project: 'GolfCRM/bay-daily-codes', tool: 'Bash' },
      { at: NOW - HOUR, kind: 'celebrate', project: 'GolfCRM/bay-daily-codes' },
      { at: NOW - MIN, kind: 'celebrate', project: 'ganyu-pet' },
    ),
  };
  return makeLedger({ files });
}

test('recent(n) returns the newest n, newest first', () => {
  const { ledger } = seeded();
  assert.deepEqual(ledger.recent(3).map((e) => e.at), [NOW - MIN, NOW - HOUR, NOW - 2 * HOUR]);
  assert.equal(ledger.recent(100).length, 6, 'asking for more than there is returns all of it');
  assert.equal(ledger.recent().length, 6, 'the default covers a seeded file');
});

test('recent(n) survives a nonsense n', () => {
  const { ledger } = seeded();
  for (const bad of [0, -1, NaN, 'three', null]) {
    assert.equal(ledger.recent(bad).length, 6, `n=${String(bad)}`);
  }
});

test('since(ms) is inclusive of the boundary and newest first', () => {
  const { ledger } = seeded();
  assert.deepEqual(
    ledger.since(NOW - 2 * HOUR).map((e) => e.kind),
    ['celebrate', 'celebrate', 'waiting'],
  );
  assert.equal(ledger.since(NOW + HOUR).length, 0, 'nothing after the future');
  assert.equal(ledger.since('nonsense').length, 6, 'an unusable timestamp means all of it');
});

test('forProject scopes recall to one project, case-insensitively', () => {
  const { ledger } = seeded();
  assert.deepEqual(
    ledger.forProject('ganyu-pet').map((e) => e.kind),
    ['celebrate', 'recovered', 'failed', 'greeting'],
  );
  assert.equal(ledger.forProject('GANYU-PET').length, 4, 'Windows hands back whatever case was typed');
  assert.equal(ledger.forProject('  ganyu-pet  ').length, 4);
  assert.deepEqual(ledger.forProject('ganyu-pet', 2).map((e) => e.kind), ['celebrate', 'recovered']);
  assert.deepEqual(ledger.forProject('never-heard-of-it'), []);
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.deepEqual(ledger.forProject(bad), [], `project ${JSON.stringify(bad)}`);
  }
});

test('stats reports the span of what she remembers', () => {
  const { ledger } = seeded();
  assert.deepEqual(ledger.stats(), {
    path: FILE,
    enabled: true,
    entries: 6,
    oldest: NOW - 5 * HOUR,
    newest: NOW - MIN,
    maxEntries: DEFAULT_MAX_ENTRIES,
  });
});

// ---------------------------------------------------------------------------
// relative phrasing
// ---------------------------------------------------------------------------

test('describeSpan matches the phrasing she already uses', () => {
  assert.equal(describeSpan(20_000), null, 'under a minute is not worth a phrase');
  assert.equal(describeSpan(12 * MIN), 'about 10 minutes');
  assert.equal(describeSpan(40 * MIN), 'about 40 minutes');
  // The crossover from minutes to hours is at 75, exactly as in
  // context.describeDuration — an hour flat is still counted in minutes there.
  assert.equal(describeSpan(HOUR), 'about 60 minutes');
  assert.equal(describeSpan(90 * MIN), 'about an hour and a half');
  assert.equal(describeSpan(2 * HOUR), 'about 2 hours');
  assert.equal(describeSpan(5 * HOUR), 'about 5 hours');
  assert.equal(describeSpan('nonsense'), null);
});

test('describeAgo says a duration up close and a daypart further out', () => {
  const at = (h, m = 0) => new Date(2026, 6, 30, h, m).getTime();
  const late = at(23, 30);

  assert.equal(describeAgo(late - 20_000, late), 'just now');
  assert.equal(describeAgo(at(23, 0), late), 'about 30 minutes ago');
  assert.equal(describeAgo(at(21, 30), late), 'about 2 hours ago');
  assert.equal(describeAgo(at(19, 0), late), 'earlier this evening', 'past 4 hours it becomes a memory');
  assert.equal(describeAgo(at(15, 0), late), 'earlier this afternoon');
  assert.equal(describeAgo(at(9, 0), late), 'earlier this morning');
  assert.equal(describeAgo(at(2, 0), late), 'in the small hours');
  assert.equal(describeAgo(null, late), null);
});

test('describeAgo crosses midnight the way he actually works', () => {
  const oneAm = new Date(2026, 6, 31, 1, 0).getTime();
  assert.equal(describeAgo(new Date(2026, 6, 30, 20, 0).getTime(), oneAm), 'yesterday evening');
  assert.equal(describeAgo(new Date(2026, 6, 30, 23, 0).getTime(), oneAm), 'about 2 hours ago');
  assert.equal(describeAgo(new Date(2026, 6, 27, 20, 0).getTime(), oneAm), '4 days ago');

  const fourAm = new Date(2026, 6, 31, 4, 0).getTime();
  assert.equal(describeAgo(new Date(2026, 6, 30, 23, 0).getTime(), fourAm), 'last night');
  assert.equal(describeAgo(new Date(2026, 6, 31, 1, 0).getTime(), fourAm), 'about 3 hours ago');
});

// ---------------------------------------------------------------------------
// the digest — the part that goes into every request
// ---------------------------------------------------------------------------

test('the digest names what broke, what cleared, and roughly when', () => {
  const { ledger } = seeded();
  const digest = ledger.digest({ now: NOW });

  assert.match(digest, /^You remember, going back about 5 hours: /);
  // Both phrasings in one line: past four hours it stops being arithmetic.
  assert.match(digest, /one failure \(Bash\), earlier this evening/);
  assert.match(digest, /one recovery, about 3 hours ago/);
  assert.match(digest, /one approval you waited on, about 2 hours ago/);
  assert.match(digest, /Projects: ganyu-pet, GolfCRM\/bay-daily-codes\./);
});

test('the digest prefers the caller\'s clause over the bare tool name, and lists at most two', () => {
  const files = {
    [FILE]: jsonl(
      { at: NOW - 30 * MIN, kind: 'failed', tool: 'Bash', detail: 'running `npm test`' },
      { at: NOW - 20 * MIN, kind: 'failed', tool: 'Edit', detail: 'editing index.ts' },
      { at: NOW - 10 * MIN, kind: 'failed', tool: 'Read', detail: 'reading persona.mjs' },
    ),
  };
  const { ledger } = makeLedger({ files });
  const digest = ledger.digest({ now: NOW });
  assert.match(digest, /3 failures \(running `npm test`, editing index\.ts\), the last about 10 minutes ago/);
  assert.equal(digest.includes('persona.mjs'), false, 'an inventory is noise');
});

test('the digest omits every section it has nothing for', () => {
  const files = { [FILE]: jsonl({ at: NOW - 10 * MIN, kind: 'celebrate', project: 'ganyu-pet' }) };
  const { ledger } = makeLedger({ files });
  const digest = ledger.digest({ now: NOW });

  assert.equal(digest, 'You remember, going back about 10 minutes: one task finished.\nProjects: ganyu-pet.');
  for (const word of ['failure', 'approval', 'recovery', 'noticed']) {
    assert.equal(digest.includes(word), false, `"${word}" leaked into a digest with none of them`);
  }
  assert.doesNotMatch(digest, /\b0 /, 'a count of nothing is an omitted clause, never "0 failures"');
});

test('the projects line is dropped when no entry knows its project', () => {
  const files = { [FILE]: jsonl({ at: NOW - MIN, kind: 'waiting' }) };
  const { ledger } = makeLedger({ files });
  const digest = ledger.digest({ now: NOW });
  assert.equal(digest.includes('Projects:'), false);
  assert.equal(digest.split('\n').length, 1);
});

test('a pattern she remarked on is rendered as something she could say', () => {
  const files = {
    [FILE]: jsonl(
      { at: NOW - 20 * MIN, kind: 'notable', detail: 'many-sessions' },
      { at: NOW - 10 * MIN, kind: 'notable', detail: 'repeat-file', project: 'ganyu-pet' },
    ),
  };
  const { ledger } = makeLedger({ files });
  const digest = ledger.digest({ now: NOW });
  assert.match(digest, /you noticed the same file kept coming back/, 'the newest pattern, in words');
  assert.equal(digest.includes('repeat-file'), false, 'never the raw pattern name');
});

test('an unknown pattern name is still readable rather than dropped', () => {
  const files = { [FILE]: jsonl({ at: NOW - MIN, kind: 'notable', detail: 'a fifth thing entirely' }) };
  const { ledger } = makeLedger({ files });
  assert.match(ledger.digest({ now: NOW }), /you noticed a fifth thing entirely/);
});

test('the digest is null when there is nothing worth saying', () => {
  const { ledger } = makeLedger();
  assert.equal(ledger.digest({ now: NOW }), null, 'empty ledger');

  const old = makeLedger({ files: { [FILE]: jsonl({ at: NOW - 30 * HOUR, kind: 'failed' }) } });
  assert.equal(old.ledger.digest({ now: NOW }), null, 'everything is outside the window');
  assert.match(old.ledger.digest({ now: NOW, windowMs: 40 * HOUR }), /one failure/, 'a wider window sees it');
});

test('the digest stays short however much she has witnessed', () => {
  const entries = [];
  for (let i = 0; i < 400; i += 1) {
    entries.push({
      at: NOW - (400 - i) * MIN,
      kind: LEDGER_KINDS[i % LEDGER_KINDS.length],
      project: `project-with-a-long-name-${i % 9}`,
      tool: `ToolNumber${i}`,
      detail: `doing something wordy and specific number ${i} in a file with a long name`,
    });
  }
  const { ledger } = makeLedger({ files: { [FILE]: jsonl(...entries) } });
  const digest = ledger.digest({ now: NOW, windowMs: 24 * HOUR });

  assert.ok(digest.length <= MAX_DIGEST_CHARS, `digest was ${digest.length} chars`);
  assert.ok(digest.split('\n').length <= 2, 'two lines at most');
  assert.equal(digest.split('; ').length <= 4, true, 'four clauses at most, ranked');
  assert.match(digest, /^You remember/);
});

test('the digest reads across a corrupt file rather than falling over', () => {
  const files = {
    [FILE]: `{"at":1,"kind":"fai\n${jsonl({ at: NOW - 5 * MIN, kind: 'failed', tool: 'Bash', project: 'ganyu-pet' })}`,
  };
  const { ledger } = makeLedger({ files });
  assert.match(ledger.digest({ now: NOW }), /one failure \(Bash\), about 5 minutes ago/);
});

test('the digest defaults its clock to the injected now', () => {
  const files = { [FILE]: jsonl({ at: NOW - 40 * MIN, kind: 'waiting', project: 'ganyu-pet' }) };
  const { ledger } = makeLedger({ files });
  assert.equal(ledger.digest(), ledger.digest({ now: NOW }));
  assert.match(ledger.digest(), /about 40 minutes ago/);
});

// ---------------------------------------------------------------------------
// constructed with nothing
// ---------------------------------------------------------------------------

test('with no path or no fs every call still answers, and nothing is written', () => {
  const fs = fakeFs();
  for (const ledger of [
    createLedger(),
    createLedger({ filePath: FILE }),
    createLedger({ fs }),
    createLedger({ filePath: '', fs }),
    createLedger({ filePath: FILE, fs: { appendFileSync: 1 } }),
  ]) {
    assert.equal(ledger.enabled, false);
    assert.equal(ledger.record(mk('failed')), null);
    assert.deepEqual(ledger.recent(5), []);
    assert.deepEqual(ledger.since(0), []);
    assert.deepEqual(ledger.forProject('ganyu-pet'), []);
    assert.equal(ledger.digest({ now: NOW }), null);
    assert.equal(ledger.stats().enabled, false);
  }
  assert.deepEqual(fs.calls, [], 'a disabled ledger never touches the fs it was given');
});
