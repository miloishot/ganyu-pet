// test/sessions.test.mjs — module D, sessions.
//
// Two things are being proved here, and the second one matters more.
//
// 1. That the parser survives reality. Transcripts are appended to while a
//    session runs, so a torn last line is the normal case rather than the edge
//    case; the fixtures below are shaped from real transcripts on this machine
//    (line types, content types, the noise wrappers, the ordering).
//
// 2. That nothing but the four allowed things can get out. `readSession` is
//    pointed at a fixture carrying a private key, an API key, a diff, a file
//    dump, tool inputs, tool results and a thinking block — every category the
//    module is supposed to refuse — and the whole digest is then searched for
//    any trace of them. That test is the reason this module is allowed to exist.
//
// NOTHING HERE READS THE REAL `~/.claude/projects`. Every byte comes from the
// fixture filesystem built in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SESSION_LIMIT,
  assistantNote,
  createSessions,
  describeWhen,
  dirMatchesProject,
  flattenMarkdown,
  listSessions,
  mangleCwd,
  ownerAsk,
  problemsFrom,
  readSession,
  stripCode,
  summarizeSession,
} from '../src/main/sessions.mjs';

// ---------------------------------------------------------------- fixture fs

const norm = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');

/**
 * A filesystem out of a flat `{path: contents}` map. Directories are implied by
 * the paths, which is how the real tree is shaped too — nothing here has to
 * declare `C--Users-…` as a directory, it simply has children.
 *
 * `mtimes` is separate because ordering is the thing `listSessions` promises and
 * the fixtures need to set it independently of content.
 */
function fakeFs(files = {}, { mtimes = {} } = {}) {
  const entries = new Map(Object.entries(files).map(([p, v]) => [norm(p), String(v)]));

  const childrenOf = (dir) => {
    const prefix = `${norm(dir)}/`;
    const names = new Set();
    for (const p of entries.keys()) {
      if (!p.startsWith(prefix)) continue;
      names.add(p.slice(prefix.length).split('/')[0]);
    }
    return [...names];
  };

  const isDir = (p) => childrenOf(p).length > 0;

  return {
    readdirSync(dir) {
      const names = childrenOf(dir);
      if (names.length === 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return names;
    },
    statSync(p) {
      const key = norm(p);
      if (entries.has(key)) {
        return {
          size: Buffer.byteLength(entries.get(key), 'utf8'),
          mtimeMs: mtimes[key] ?? mtimes[p] ?? 1_000,
          isDirectory: () => false,
        };
      }
      if (isDir(key)) return { size: 0, mtimeMs: 0, isDirectory: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readFileSync(p) {
      const key = norm(p);
      if (!entries.has(key)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return entries.get(key);
    },
    // Only the tail-read path uses these; a fs without them must still work.
    openSync(p) {
      const key = norm(p);
      if (!entries.has(key)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { buf: Buffer.from(entries.get(key), 'utf8') };
    },
    readSync(fd, buffer, offset, length, position) {
      const src = fd.buf.subarray(position, position + length);
      src.copy(buffer, offset);
      return src.length;
    },
    closeSync() {},
  };
}

const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

const PROJECTS = 'C:/fixture/projects';
const GANYU_DIR = `${PROJECTS}/C--Users-kw11l-Desktop-ganyu-pet`;
const GOLF_DIR = `${PROJECTS}/C--Users-kw11l-desktop-GolfCRM`;
const GOLF_WORKTREE = `${PROJECTS}/C--Users-kw11l-orca-workspaces-GolfCRM-promo-codes`;

const user = (text, extra = {}) => ({
  type: 'user',
  cwd: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
  timestamp: '2026-07-31T10:00:00.000Z',
  message: { role: 'user', content: text },
  ...extra,
});

const assistant = (text, extra = {}) => ({
  type: 'assistant',
  cwd: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
  timestamp: '2026-07-31T10:01:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  ...extra,
});

const title = (aiTitle) => ({ type: 'ai-title', aiTitle });

/** Long enough to clear MIN_NOTE_CHARS, and written like a real summary. */
const REAL_NOTE =
  'The redemption flow is going through cleanly again after the guard was put back on the write path.';
const SECOND_NOTE =
  'Both branches are merged now and the deploy branch carries everything that was outstanding.';

// ------------------------------------------------------- naming and matching

test('mangleCwd reproduces the directory names Claude Code actually writes', () => {
  // All three verified against the real tree on this machine: the `:\` pair
  // makes the doubled hyphen, and `.` and `_` are hyphens too.
  assert.equal(
    mangleCwd('C:\\Users\\kw11l\\Desktop\\ganyu-pet'),
    'C--Users-kw11l-Desktop-ganyu-pet',
  );
  assert.equal(mangleCwd('C:\\Users\\kw11l\\.claude'), 'C--Users-kw11l--claude');
  assert.equal(
    mangleCwd('C:\\Users\\kw11l\\desktop\\zmk-new_corne'),
    'C--Users-kw11l-desktop-zmk-new-corne',
  );
  assert.equal(mangleCwd(null), '');
});

test('a project matches its own directory and its worktrees, not a word that contains it', () => {
  assert.equal(dirMatchesProject('C--Users-kw11l-desktop-GolfCRM', 'GolfCRM'), true);
  assert.equal(
    dirMatchesProject('C--Users-kw11l-orca-workspaces-GolfCRM-promo-codes', 'GolfCRM'),
    true,
  );
  assert.equal(dirMatchesProject('C--Users-kw11l-Desktop-ganyu-pet', 'ganyu-pet'), true);
  // Case is decided by whatever the shell passed that day, so it cannot matter.
  assert.equal(dirMatchesProject('C--Users-kw11l-desktop-GolfCRM', 'golfcrm'), true);
  // A segment, not a substring: "Golf" must not match "GolfCRM".
  assert.equal(dirMatchesProject('C--Users-kw11l-desktop-GolfCRM', 'Golf'), false);
  assert.equal(dirMatchesProject('C--Users-kw11l-Desktop-salesbridge', 'GolfCRM'), false);
  // No project named is not a filter.
  assert.equal(dirMatchesProject('anything', ''), true);
});

// ------------------------------------------------------------- listSessions

function listingFs() {
  return fakeFs(
    {
      [`${GANYU_DIR}/aaa.jsonl`]: jsonl([title('Pet work')]),
      [`${GANYU_DIR}/bbb.jsonl`]: jsonl([title('Older pet work')]),
      [`${GANYU_DIR}/notes.txt`]: 'not a transcript',
      [`${GANYU_DIR}/empty.jsonl`]: '',
      [`${GOLF_DIR}/ccc.jsonl`]: jsonl([title('Golf work')]),
      [`${GOLF_WORKTREE}/ddd.jsonl`]: jsonl([title('Promo codes')]),
    },
    {
      mtimes: {
        [`${GANYU_DIR}/aaa.jsonl`]: 5_000,
        [`${GANYU_DIR}/bbb.jsonl`]: 1_000,
        [`${GOLF_DIR}/ccc.jsonl`]: 4_000,
        [`${GOLF_WORKTREE}/ddd.jsonl`]: 3_000,
      },
    },
  );
}

test('listSessions returns transcripts newest first, ignoring non-transcripts and empty files', () => {
  const found = listSessions({ fs: listingFs(), projectsDir: PROJECTS });
  assert.deepEqual(found.map((f) => f.id), ['aaa', 'ccc', 'ddd', 'bbb']);
  // A zero-byte transcript is a session that opened and never said anything.
  assert.equal(found.some((f) => f.id === 'empty'), false);
  assert.equal(found.some((f) => f.id === 'notes'), false);
  assert.equal(found[0].dir, 'C--Users-kw11l-Desktop-ganyu-pet');
  assert.ok(found[0].bytes > 0);
});

test('a cwd scopes the listing to that one working directory, case-insensitively', () => {
  const fs = listingFs();
  const exact = listSessions({ fs, projectsDir: PROJECTS, cwd: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet' });
  assert.deepEqual(exact.map((f) => f.id), ['aaa', 'bbb']);

  // `Desktop` vs `desktop`: both spellings occur in the real tree, so a cwd
  // whose case does not match the recorded directory must still find it.
  const cased = listSessions({ fs, projectsDir: PROJECTS, cwd: 'C:\\Users\\kw11l\\DESKTOP\\ganyu-pet' });
  assert.deepEqual(cased.map((f) => f.id), ['aaa', 'bbb']);

  // An unknown cwd finds nothing rather than falling back to everything.
  assert.deepEqual(listSessions({ fs, projectsDir: PROJECTS, cwd: 'C:\\nowhere' }), []);
});

test('a project scopes the listing to the repo and its worktrees', () => {
  const found = listSessions({ fs: listingFs(), projectsDir: PROJECTS, project: 'GolfCRM' });
  assert.deepEqual(found.map((f) => f.id), ['ccc', 'ddd']);
});

test('the limit is honoured and capped, and a missing tree is not an error', () => {
  const fs = listingFs();
  assert.equal(listSessions({ fs, projectsDir: PROJECTS, limit: 2 }).length, 2);
  assert.ok(listSessions({ fs, projectsDir: PROJECTS, limit: 9999 }).length <= MAX_SESSION_LIMIT);
  assert.equal(listSessions({ fs, projectsDir: 'C:/does/not/exist' }).length, 0);
  assert.deepEqual(listSessions({}), []);
  assert.deepEqual(listSessions({ fs, projectsDir: null }), []);
});

// -------------------------------------------------------------- the parser

test('readSession pulls the title, his asks and the prose out of a well-formed transcript', () => {
  const fs = fakeFs({
    [`${GANYU_DIR}/s.jsonl`]: jsonl([
      title('Redemption flow'),
      user('the redeem endpoint is returning 500 please look'),
      assistant(REAL_NOTE),
      user('now merge it'),
      assistant(SECOND_NOTE),
    ]),
  });

  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });
  assert.equal(digest.title, 'Redemption flow');
  assert.equal(digest.project, 'ganyu-pet');
  assert.equal(digest.skipped, 0);
  assert.equal(digest.lines, 5);
  // Chronological, after the newest-weighted collection walked backwards.
  assert.deepEqual(digest.asks, [
    'the redeem endpoint is returning 500 please look',
    'now merge it',
  ]);
  assert.deepEqual(digest.notes, [REAL_NOTE, SECOND_NOTE]);
});

test('a torn last line is skipped and counted — one bad line never costs the others', () => {
  // The normal case, not an edge case: a live session is being appended to while
  // this runs, so the final line is routinely half-written.
  const good = jsonl([title('Live session'), user('do the thing'), assistant(REAL_NOTE)]);
  const fs = fakeFs({ [`${GANYU_DIR}/s.jsonl`]: `${good}{"type":"assistant","message":{"content":[{"type":"te` });

  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });
  assert.equal(digest.skipped, 1);
  assert.equal(digest.title, 'Live session');
  assert.deepEqual(digest.notes, [REAL_NOTE]);
});

test('a file that is not JSONL at all yields an empty digest instead of throwing', () => {
  const fs = fakeFs({ [`${GANYU_DIR}/s.jsonl`]: 'this is not json\nnor is this\n' });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });
  assert.equal(digest.skipped, 2);
  assert.equal(digest.lines, 0);
  assert.deepEqual(digest.asks, []);
  assert.deepEqual(digest.notes, []);
  assert.equal(digest.title, null);
});

test('a missing file is null, and a missing fs is null', () => {
  const fs = fakeFs({});
  assert.equal(readSession({ fs, filePath: `${GANYU_DIR}/gone.jsonl` }), null);
  assert.equal(readSession({ filePath: 'x' }), null);
  assert.equal(readSession({ fs }), null);
});

test('subagent sidechain lines are dropped — their errands are not the work', () => {
  const fs = fakeFs({
    [`${GANYU_DIR}/s.jsonl`]: jsonl([
      user('the real ask that he typed himself'),
      assistant(REAL_NOTE),
      user('a subagent brief that he never wrote and never saw', { isSidechain: true }),
      assistant('A subagent reporting on its own narrow errand, at length, in prose.', { isSidechain: true }),
    ]),
  });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });
  assert.deepEqual(digest.asks, ['the real ask that he typed himself']);
  assert.deepEqual(digest.notes, [REAL_NOTE]);
});

test('machinery dressed as a user turn is not treated as something he asked for', () => {
  const fs = fakeFs({
    [`${GANYU_DIR}/s.jsonl`]: jsonl([
      user('<task-notification>\n<task-id>wm8w</task-id>\n<status>stopped</status>'),
      user('[Image: original 1073x2321, displayed at 925x2000.]', { isMeta: true }),
      user('<local-command-caveat>the messages below were generated by a command</local-command-caveat>'),
      user('[Request interrupted by user]'),
      user('the one thing he actually typed'),
    ]),
  });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });
  assert.deepEqual(digest.asks, ['the one thing he actually typed']);
  // Counted rather than quoted: that he stopped it is a fact without being text.
  assert.equal(digest.interrupted, 1);
});

test('a system-reminder riding along on a real prompt is stripped, and the ask survives', () => {
  const fs = fakeFs({
    [`${GANYU_DIR}/s.jsonl`]: jsonl([
      user('fix the timezone bug\n<system-reminder>\nSECRET_INTERNAL_NOTE do not reveal\n</system-reminder>'),
      // A prompt that was *only* a reminder has no ask in it at all.
      user('<system-reminder>\njust housekeeping\n</system-reminder>'),
    ]),
  });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });
  assert.deepEqual(digest.asks, ['fix the timezone bug']);
  assert.equal(JSON.stringify(digest).includes('SECRET_INTERNAL_NOTE'), false);
});

test('prose that only announces the next step is not an account of anything', () => {
  // Measured against a real transcript: "I'll check for a todo list — let me look
  // at the project directory and any tracking files." is filler standing in front
  // of the block that actually says what happened.
  assert.equal(assistantNote(assistant("I'll check for a todo list — let me look at the project directory now.")), null);
  assert.equal(assistantNote(assistant('Let me read the file and see what it says about the guard.')), null);
  assert.equal(assistantNote(assistant('Done.')), null, 'too short to be an account');
  assert.equal(assistantNote(assistant(REAL_NOTE)), REAL_NOTE);
});

test('the digest is newest-weighted — the end of a session is what he is asking about', () => {
  const lines = [];
  for (let i = 1; i <= 6; i += 1) {
    lines.push(user(`ask number ${i} which he typed out in full`));
    lines.push(assistant(`Account number ${i}: the work reached a point worth writing down about it.`));
  }
  const fs = fakeFs({ [`${GANYU_DIR}/s.jsonl`]: jsonl(lines) });

  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl`, maxAsks: 2, maxNotes: 2 });
  // The last two of each, still in order.
  assert.deepEqual(digest.asks, [
    'ask number 5 which he typed out in full',
    'ask number 6 which he typed out in full',
  ]);
  assert.ok(digest.notes[0].startsWith('Account number 5'));
  assert.ok(digest.notes[1].startsWith('Account number 6'));
});

test('an oversized transcript is read from its tail, and the partial first line is discarded', () => {
  const body = jsonl([
    title('Early title'),
    user('an early ask that will fall outside the window'),
    assistant('An early account that will fall outside the tail window entirely, so it is gone.'),
    title('Later title'),
    user('the late ask he actually means'),
    assistant(REAL_NOTE),
  ]);
  const fs = fakeFs({ [`${GANYU_DIR}/big.jsonl`]: body });

  // A byte budget that deliberately starts *inside* the early-account line, so
  // the read begins mid-JSON — which is the whole point of the test.
  const cutFrom = body.indexOf('{"type":"ai-title","aiTitle":"Later title"');
  assert.ok(cutFrom > 40, 'fixture must have a line before the cut to be torn');
  const digest = readSession({
    fs,
    filePath: `${GANYU_DIR}/big.jsonl`,
    maxBytes: Buffer.byteLength(body, 'utf8') - cutFrom + 30,
  });
  assert.equal(digest.truncated, true);
  assert.equal(digest.skipped, 0, 'the partial first line is dropped, not fed to JSON.parse');
  assert.deepEqual(digest.asks, ['the late ask he actually means']);
  assert.deepEqual(digest.notes, [REAL_NOTE]);
  assert.equal(digest.title, 'Later title');
});

test('a fs without openSync still reads the whole file rather than failing', () => {
  const full = fakeFs({ [`${GANYU_DIR}/s.jsonl`]: jsonl([title('T'), assistant(REAL_NOTE)]) });
  const limited = {
    readFileSync: full.readFileSync,
    statSync: full.statSync,
    readdirSync: full.readdirSync,
  };
  const digest = readSession({ fs: limited, filePath: `${GANYU_DIR}/s.jsonl`, maxBytes: 10 });
  assert.equal(digest.truncated, false);
  assert.deepEqual(digest.notes, [REAL_NOTE]);
});

// ------------------------------------------------------------------ PRIVACY
//
// The reason the module is allowed to exist. Everything a transcript can carry
// that must never reach the network goes into one fixture, and the entire
// digest is then searched for any trace of it.

const SECRETS = Object.freeze({
  anthropic: 'sk-ant-api03-ZZZfakefakefake1234567890abcdefFAKE',
  stripe: 'sk_live_51H8xyzABCDEF0123456789',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  github: 'ghp_abcdefghij1234567890ABCDEFGHIJ12345',
  google: 'GOCSPX-abcdefghij1234567890',
  npm: 'npm_abcdefghijklmnopqrstuvwxyz012345',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxfakekeymaterialhere\n-----END RSA PRIVATE KEY-----',
  db: 'postgres://admin:hunter2please@db.internal:5432/prod',
});

/** Everything the allowlist is supposed to make unreachable. */
function hostileTranscript() {
  return jsonl([
    title('Wire up billing'),

    // 1. His prompt, with a pasted credential in it.
    user(`here is the key ${SECRETS.anthropic} use it for the billing test please`),
    user(`and the db is ${SECRETS.db} — the stripe one is ${SECRETS.stripe}`),

    // 2. A tool_use: the diff and the file body the agent wrote.
    {
      type: 'assistant',
      cwd: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Edit',
            input: {
              file_path: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet\\src\\billing.ts',
              old_string: 'const RATE = 1',
              new_string: `const RATE = 2\nconst KEY = "${SECRETS.github}"`,
              content: `MASTER_PASSWORD=correcthorsebatterystaple\nAWS_KEY=${SECRETS.aws}`,
            },
          },
        ],
      },
    },

    // 3. A tool_result: the command output and the file dump that came back.
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: `--- a/.env\n+++ b/.env\n@@ -1 +1,2 @@\n+GOOGLE_SECRET=${SECRETS.google}\n+NPM_TOKEN=${SECRETS.npm}\nPRIVATE_CUSTOMER_LIST: alice@corp.example, bob@corp.example`,
          },
        ],
      },
    },

    // 4. A thinking block — the model's private reasoning, which quotes code.
    {
      type: 'assistant',
      cwd: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `The JWT is ${SECRETS.jwt} and the key file holds ${SECRETS.pem}` },
          {
            type: 'text',
            // Real prose — but with a fenced diff and a fenced file dump inside
            // it, which is exactly how an assistant writes up a change.
            text: [
              'The billing rate was doubling on retries because the guard ran after the write.',
              '',
              '```diff',
              '--- a/src/billing.ts',
              '+++ b/src/billing.ts',
              `-const KEY = "${SECRETS.github}"`,
              `+const KEY = process.env.KEY // ${SECRETS.aws}`,
              '```',
              '',
              'It is charging once per order again now.',
              '',
              '```',
              `DATABASE_URL=${SECRETS.db}`,
              `ANTHROPIC_API_KEY=${SECRETS.anthropic}`,
              '```',
            ].join('\n'),
          },
        ],
      },
    },

    // 5. An attachment, and the file-history records — whole file bodies.
    { type: 'attachment', attachment: { type: 'file', content: `WHOLE FILE BODY ${SECRETS.pem}` } },
    { type: 'file-history-snapshot', snapshot: { 'src/billing.ts': `const KEY = "${SECRETS.stripe}"` } },
    { type: 'file-history-delta', backup: `patch text ${SECRETS.npm}` },

    // 6. A system line carrying a hook command.
    { type: 'system', subtype: 'stop_hook_summary', hookInfos: [{ command: `curl -H "auth: ${SECRETS.jwt}"` }] },
  ]);
}

test('PRIVACY: no credential, diff, file dump, tool input, tool result or thinking survives the digest', () => {
  const fs = fakeFs({ [`${GANYU_DIR}/hostile.jsonl`]: hostileTranscript() });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/hostile.jsonl` });
  const summary = summarizeSession(digest, { maxChars: 2000 });

  // Everything the module could possibly emit, in one string.
  const emitted = `${JSON.stringify(digest)}\n${summary}`;

  for (const [name, secret] of Object.entries(SECRETS)) {
    for (const fragment of secret.split(/[\s\n]+/)) {
      if (fragment.length < 12) continue;
      assert.equal(
        emitted.includes(fragment),
        false,
        `${name} survived into the digest: ${fragment}`,
      );
    }
  }

  for (const forbidden of [
    'correcthorsebatterystaple',
    'hunter2please',
    'PRIVATE_CUSTOMER_LIST',
    'alice@corp.example',
    'WHOLE FILE BODY',
    'old_string',
    'new_string',
    '+++ b/',
    '--- a/',
    '@@ -1',
    'process.env.KEY',
    'DATABASE_URL=',
    'ANTHROPIC_API_KEY=',
    'const KEY',
    'const RATE',
    'src/billing.ts',
    'curl -H',
  ]) {
    assert.equal(emitted.includes(forbidden), false, `leaked: ${forbidden}`);
  }

  // And the prose that *is* allowed did come through, or the test above would
  // pass just as well on a module that returned nothing at all.
  assert.equal(digest.title, 'Wire up billing');
  assert.ok(
    digest.notes.some((n) => n.includes('charging once per order again')),
    `the assistant's actual account is missing: ${JSON.stringify(digest.notes)}`,
  );
  assert.ok(
    digest.notes.some((n) => n.includes('guard ran after the write')),
    'the explanation of the bug is missing',
  );
});

test('PRIVACY: his pasted credentials are redacted out of his own asks, and the ask still reads', () => {
  const fs = fakeFs({ [`${GANYU_DIR}/hostile.jsonl`]: hostileTranscript() });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/hostile.jsonl` });

  const asks = digest.asks.join(' ');
  assert.equal(asks.includes(SECRETS.anthropic), false);
  assert.equal(asks.includes('hunter2please'), false);
  // The readable half survives, which is the point of redacting by value and not
  // by line: she can still see he was doing something with a key.
  assert.match(asks, /use it for the billing test/);
  assert.match(asks, /redacted/);
});

test('fenced code is cut out of prose, including a fence left open by a live session', () => {
  assert.equal(stripCode('before\n```js\nconst a = 1\n```\nafter').replace(/\n+/g, ' ').trim(), 'before after');
  assert.equal(stripCode('before\n~~~\nsecret\n~~~\nafter').replace(/\n+/g, ' ').trim(), 'before after');
  // Unterminated: a transcript being appended to cuts a block mid-way, and
  // everything after the opening fence must be treated as code.
  assert.equal(stripCode('before\n```\nconst SECRET = 1').trim(), 'before');
  // A diff pasted without any fence at all.
  assert.equal(stripCode('note\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@').replace(/\n+/g, ' ').trim(), 'note');
});

test('a tool_result masquerading as user text cannot smuggle output through', () => {
  // Only `{type:'text'}` parts are read; `tool_result` is not reachable.
  const line = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', content: 'FILE DUMP THAT MUST NOT ESCAPE' },
        { type: 'text', text: 'why is it still failing' },
      ],
    },
  };
  assert.equal(ownerAsk(line), 'why is it still failing');
});

// ---------------------------------------------------- markdown and problems

test('markdown is flattened into something a person could read aloud', () => {
  const flat = flattenMarkdown([
    '## Merged',
    '',
    '- **PR #3** → `554e411` — the write-path guard',
    '1. Merge #3 then #4',
    'See https://github.com/miloishot/GolfCRM/pull/3 for the details',
  ].join('\n'));

  assert.equal(flat.includes('##'), false);
  assert.equal(flat.includes('**'), false);
  assert.equal(flat.includes('`'), false);
  assert.equal(flat.includes('http'), false, 'a bare URL is pure noise in something spoken');
  // Backtick *contents* stay — a short sha or a file name may legitimately matter.
  assert.match(flat, /554e411/);
  assert.match(flat, /the write-path guard/);
  // Joined lines gain terminators so the sentence splitter sees real boundaries.
  assert.match(flat, /Merged\./);
});

test('a single line keeps his exact words — no invented full stop', () => {
  // His ask and the session title are quoted back into the prompt, and putting a
  // full stop on the end of "merge three and four" is putting words in his mouth.
  assert.equal(flattenMarkdown('merge three and four'), 'merge three and four');
  assert.equal(flattenMarkdown('# Check team todo list'), 'Check team todo list');
});

test('a heading fragment is not reported as something that went wrong', () => {
  // The real defect this guards: "blocked on" inside the heading "Do now
  // (blocked on you, in order)" was being offered as a failure, because `1.` in
  // the ordered list underneath it read as the end of a sentence.
  const heading = flattenMarkdown('## Do now (blocked on you, in order)\n1. Merge #3 then #4');
  assert.deepEqual(problemsFrom([heading]), []);
});

test('a real failure sentence is reported, newest last, without duplicates', () => {
  const notes = [
    'The migration failed twice on the collation mismatch before it went through.',
    'Everything is green now and the deploy branch carries all of the work.',
    'The mobile layout is still broken below 390px and I could not get to it.',
  ];
  const problems = problemsFrom(notes);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /migration failed twice/);
  assert.match(problems[1], /still broken below 390px/);

  assert.deepEqual(problemsFrom(['x failed. x failed. x failed.'.replace(/x/g, 'the same step somehow failed')]).length, 1);
  assert.deepEqual(problemsFrom([]), []);
});

// -------------------------------------------------------------- summarizing

test('describeWhen speaks in his hours', () => {
  const now = Date.parse('2026-07-31T12:00:00Z');
  assert.equal(describeWhen(now - 30_000, now), 'just now');
  assert.equal(describeWhen(now - 25 * 60_000, now), '25 minutes ago');
  assert.equal(describeWhen(now - 60 * 60_000, now), 'about an hour ago');
  assert.equal(describeWhen(now - 5 * 3_600_000, now), 'about 5 hours ago');
  assert.equal(describeWhen(now - 26 * 3_600_000, now), 'yesterday');
  assert.equal(describeWhen(now - 3 * 24 * 3_600_000, now), '3 days ago');
  assert.equal(describeWhen(null, now), null);
  assert.equal(describeWhen(0, now), null);
});

test('the summary reads as an account of the work, and drops the sections it has nothing for', () => {
  const fs = fakeFs({
    [`${GANYU_DIR}/s.jsonl`]: jsonl([
      title('Redemption flow'),
      user('the redeem endpoint is returning 500 please look'),
      assistant(REAL_NOTE),
      user('[Request interrupted by user]'),
      assistant('The migration failed on the collation mismatch, so I re-ran it with a consistent locale.'),
    ]),
  });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });
  const summary = summarizeSession(digest, { now: Date.parse('2026-07-31T11:01:00Z') });

  assert.match(summary, /^Session "Redemption flow" in ganyu-pet, about an hour ago\./m);
  assert.match(summary, /What he asked for: "the redeem endpoint is returning 500 please look"/);
  assert.match(summary, /What came of it: .*redemption flow is going through cleanly/);
  assert.match(summary, /Trouble along the way: .*migration failed/);
  assert.match(summary, /He stopped it mid-way once\./);
  // It talks about the work; it does not offer a file to name.
  assert.equal(summary.includes('.mjs'), false);
});

test('the summary is bounded by the caller and never runs away', () => {
  const long = 'The work reached a genuinely notable point that is worth writing about at length. '.repeat(40);
  const fs = fakeFs({
    [`${GANYU_DIR}/s.jsonl`]: jsonl([title('Long one'), user('do it'), assistant(long), assistant(`${long}x`)]),
  });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });

  assert.ok(summarizeSession(digest, { maxChars: 300 }).length <= 300);
  assert.ok(summarizeSession(digest, { maxChars: 800 }).length <= 800);
  // The ceiling holds even against a caller asking for the moon.
  assert.ok(summarizeSession(digest, { maxChars: 999_999 }).length <= 2000);
});

test('a session with no narrative says so rather than offering a bare title', () => {
  const fs = fakeFs({ [`${GANYU_DIR}/s.jsonl`]: jsonl([title('Nothing happened')]) });
  const digest = readSession({ fs, filePath: `${GANYU_DIR}/s.jsonl` });
  assert.match(summarizeSession(digest), /Nothing was written down about what it did\./);

  assert.equal(summarizeSession(null), null);
  assert.equal(summarizeSession({ asks: [], notes: [], problems: [], interrupted: 0 }), null);
});

// ------------------------------------------------------------ createSessions

function wiredFs() {
  return fakeFs(
    {
      [`${GANYU_DIR}/new.jsonl`]: jsonl([
        title('The newest pet session'),
        user('make her stop naming files'),
        assistant('She talks about what the work achieved now instead of listing the files that changed.'),
      ]),
      [`${GANYU_DIR}/old.jsonl`]: jsonl([
        title('An older pet session'),
        user('add the wander behaviour'),
        assistant('The pet strolls along the taskbar when nothing has happened for a while, and stops when grabbed.'),
      ]),
      [`${GOLF_DIR}/golf.jsonl`]: jsonl([
        title('Merge the booking PRs'),
        user('merge three and four'),
        assistant('Both are merged and the deploy branch carries the booking guard along with the layout work.'),
      ]),
    },
    {
      mtimes: {
        [`${GANYU_DIR}/new.jsonl`]: 9_000,
        [`${GANYU_DIR}/old.jsonl`]: 2_000,
        [`${GOLF_DIR}/golf.jsonl`]: 8_000,
      },
    },
  );
}

test('read() answers about the session he is in, and counts back from it', () => {
  const sessions = createSessions({
    fs: wiredFs(),
    projectsDir: PROJECTS,
    cwd: () => 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
  });
  assert.equal(sessions.enabled, true);

  const newest = sessions.read({ which: 1 });
  assert.equal(newest.title, 'The newest pet session');
  assert.match(newest.summary, /talks about what the work achieved/);

  assert.equal(sessions.read({ which: 2 }).title, 'An older pet session');
  // Counting past the end is nothing, not a wrap-around.
  assert.equal(sessions.read({ which: 9 }), null);
});

test('read() takes a named project over the current one, worktrees included', () => {
  const sessions = createSessions({
    fs: wiredFs(),
    projectsDir: PROJECTS,
    cwd: () => 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
  });
  assert.equal(sessions.read({ project: 'GolfCRM' }).title, 'Merge the booking PRs');
  assert.equal(sessions.read({ project: 'ganyu-pet' }).title, 'The newest pet session');
});

test('a query narrows to the session that actually mentions the thing', () => {
  const sessions = createSessions({
    fs: wiredFs(),
    projectsDir: PROJECTS,
    cwd: () => 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
  });
  assert.equal(sessions.read({ query: 'wander' }).title, 'An older pet session');
  assert.equal(sessions.read({ query: 'taskbar strolls' }).title, 'An older pet session');
  assert.equal(sessions.read({ query: 'kubernetes' }), null);
});

test('with no session in the current directory it falls back to the machine as a whole', () => {
  const sessions = createSessions({
    fs: wiredFs(),
    projectsDir: PROJECTS,
    cwd: () => 'C:\\Users\\kw11l\\somewhere\\with\\no\\transcripts',
  });
  assert.equal(sessions.read({}).title, 'The newest pet session');
});

test('recent() lists titles without opening much, newest first', () => {
  const sessions = createSessions({ fs: wiredFs(), projectsDir: PROJECTS });
  assert.deepEqual(sessions.recent({ limit: 3 }).map((s) => s.title), [
    'The newest pet session',
    'Merge the booking PRs',
    'An older pet session',
  ]);
  assert.deepEqual(sessions.recent({ project: 'GolfCRM' }).map((s) => s.title), ['Merge the booking PRs']);
});

test('no fs and no projects directory is an object that answers nothing, not a crash', () => {
  const off = createSessions({});
  assert.equal(off.enabled, false);
  assert.equal(off.read({}), null);
  assert.deepEqual(off.recent(), []);

  // A cwd getter that throws is treated as no cwd at all.
  const throwing = createSessions({
    fs: wiredFs(),
    projectsDir: PROJECTS,
    cwd: () => { throw new Error('no ring yet'); },
  });
  assert.equal(throwing.read({}).title, 'The newest pet session');
});
