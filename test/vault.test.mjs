// Vault tests — what the owner's own notes are allowed to tell her.
//
// `fs` is injected and every path below is invented, so **nothing here reads
// the real vault**: that is not an accident of the design, it is the point.
// These notes are the owner's private writing, and a test that read them would
// print them into CI output the first time it failed.
//
// Three themes:
//   1. resolution — a repo directory becomes a vault project through the same
//      map, and the same loose fallback, that the shell hooks use;
//   2. privacy — the title, the date and the `Left open` bullets leave the
//      module, and the rest of the note provably does not; a blocked project
//      leaves nothing at all, and its file is never even opened;
//   3. degradation — a missing vault, a missing map, an unknown project or an
//      unreadable file all yield null, which is exactly today's behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXCLUDED_PROJECTS,
  MAX_ITEM_CHARS,
  MAX_OPEN_ITEMS,
  MAX_VAULT_DIGEST_CHARS,
  VAULT_TTL_MS,
  createVault,
  formatVaultDigest,
  isExcluded,
  noteDigest,
  normalizeName,
  parseProjectMap,
  pickNewestNote,
  repoNameFromCwd,
  resolveProject,
} from '../src/main/vault.mjs';

const PROJECTS = 'C:\\Users\\kw11l\\second-brain\\03 Projects';
const MAP = 'C:\\Users\\kw11l\\.claude\\hooks\\projects.tsv';
const at = (...parts) => [PROJECTS, ...parts].join('\\');

/** The real projects.tsv's shape: tabs, a comment header, one pair per line. */
const TSV = [
  '# Repo directory name -> vault project under "03 Projects/".',
  '# TAB separated. Lines starting with # are ignored.',
  '',
  '.claude\tClaude Config',
  'zmk-new_corne\tCorne Keyboard',
  'GolfCRM\tGolfCRM',
  'Invoco-POS\tInvoco',
  'salesbridge\tSalesbridge',
].join('\n');

/** A note in the owner's house style: frontmatter, sections, `## Left open`. */
const NOTE = `---
tags: [session-log, golfcrm]
date: 2026-07-29
type: session-log
---

# Bay codes — the timezone fix

## What shipped
- The code generator now uses the club's local timezone, not the server's.
- Backfilled 4,100 rows.

## Decisions
- Kept the legacy \`tee_time_utc\` column until the backfill is verified.
- Andrew's pricing conversation moves to next week.

## Left open
- The DST edge case at 02:00 on the changeover night
- Rotate the CI secret that leaked into the build log
- [[bay-daily-codes]] wants a second pair of eyes
- A fourth thing that must not reach the prompt
`;

/**
 * node:fs, shrunk to the three calls vault.mjs makes. `tree` is directory ->
 * entry names, `files` is path -> text; `reads` records every file actually
 * opened, which is how the Invoco exclusion is proved rather than assumed.
 */
function fakeFs({ tree = {}, files = {}, fail = {} } = {}) {
  const reads = [];
  const listed = [];
  return {
    reads,
    listed,
    existsSync: (p) => Object.hasOwn(tree, p) || Object.hasOwn(files, p),
    readdirSync(p) {
      listed.push(p);
      if (fail.readdirSync) throw new Error('readdirSync refused');
      if (!Object.hasOwn(tree, p)) throw new Error(`ENOENT ${p}`);
      return [...tree[p]];
    },
    readFileSync(p) {
      reads.push(p);
      if (fail.readFileSync) throw new Error('readFileSync refused');
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
  };
}

/** A vault holding one GolfCRM note and one Invoco note. */
function vaultFs(extra = {}) {
  return fakeFs({
    tree: {
      [PROJECTS]: ['Claude Config', 'Corne Keyboard', 'GolfCRM', 'Invoco', 'Salesbridge', 'README.md'],
      [at('GolfCRM')]: ['session-2026-07-28.md', 'session-2026-07-29.md', 'README.md'],
      [at('Invoco')]: ['session-2026-07-30.md'],
      [at('Salesbridge')]: [],
      ...(extra.tree ?? {}),
    },
    files: {
      [MAP]: TSV,
      [at('GolfCRM', 'session-2026-07-29.md')]: NOTE,
      [at('GolfCRM', 'session-2026-07-28.md')]: '# Older\n\n## Left open\n- the old thing\n',
      [at('Invoco', 'session-2026-07-30.md')]: '# Pricing\n\n## Left open\n- the tier-2 markup\n',
      ...(extra.files ?? {}),
    },
    fail: extra.fail ?? {},
  });
}

function vaultFor(cwd, opts = {}) {
  const fs = opts.fs ?? vaultFs();
  let t = opts.start ?? 1_000_000;
  const vault = createVault({
    fs,
    projectsDir: PROJECTS,
    mapPath: opts.mapPath === undefined ? MAP : opts.mapPath,
    cwd,
    now: () => t,
    ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
  });
  return { fs, vault, advance: (ms) => { t += ms; } };
}

// ------------------------------------------------------------- the map

test('the project map is read from the tsv, comments and blank lines skipped', () => {
  const map = parseProjectMap(TSV);
  assert.equal(map.get('Invoco-POS'), 'Invoco');
  assert.equal(map.get('GolfCRM'), 'GolfCRM');
  assert.equal(map.get('salesbridge'), 'Salesbridge');
  assert.equal(map.get('zmk-new_corne'), 'Corne Keyboard');
  assert.equal(map.size, 5, 'the two comment lines and the blank are not entries');
  assert.equal(map.get('# Repo directory name -> vault project under "03 Projects/".'), undefined);
});

test('a line without a tab is not a mapping', () => {
  // Spaces are not tabs: a hand-edited file with aligned columns must not
  // silently produce a project named "GolfCRM   GolfCRM".
  const map = parseProjectMap('GolfCRM   GolfCRM\nsalesbridge\tSalesbridge\n');
  assert.equal(map.size, 1);
  assert.equal(map.get('salesbridge'), 'Salesbridge');
});

test('names match case-, space- and punctuation-insensitively', () => {
  assert.equal(normalizeName('Bay Daily-Codes'), 'baydailycodes');
  assert.equal(normalizeName('bay_daily codes'), 'baydailycodes');
  assert.equal(normalizeName('.claude'), 'claude');
  assert.equal(normalizeName(null), '');
});

test('an Orca worktree resolves to its repo, not to the worktree', () => {
  // context.projectFromCwd keeps `<repo>/<worktree>` because two worktrees are
  // two pieces of work; the vault files both under the repo's one folder.
  assert.equal(repoNameFromCwd('C:\\Users\\kw11l\\orca\\workspaces\\GolfCRM\\bay-daily-codes'), 'GolfCRM');
  assert.equal(repoNameFromCwd('C:\\Users\\kw11l\\Desktop\\ganyu-pet'), 'ganyu-pet');
  assert.equal(repoNameFromCwd(''), null);
});

test('the map wins first, then a loose match against the folders that exist', () => {
  const map = parseProjectMap(TSV);
  const dirs = ['Claude Config', 'Corne Keyboard', 'GolfCRM', 'Invoco', 'Salesbridge'];

  // Mapped: the directory name and the vault folder share nothing.
  assert.equal(resolveProject({ cwd: 'D:\\code\\Invoco-POS', map, projectDirs: dirs }), 'Invoco');
  assert.equal(resolveProject({ cwd: 'D:\\code\\zmk-new_corne', map, projectDirs: dirs }), 'Corne Keyboard');
  // Unmapped, but the folder is already named after the repo bar the space.
  assert.equal(resolveProject({ cwd: 'D:\\code\\claude-config', map, projectDirs: dirs }), 'Claude Config');
  // Unmapped and unknown: no project, rather than a guess.
  assert.equal(resolveProject({ cwd: 'D:\\code\\ganyu-pet', map, projectDirs: dirs }), null);
  // No map at all is not an error — the loose match still runs.
  assert.equal(resolveProject({ cwd: 'D:\\code\\golfcrm', map: null, projectDirs: dirs }), 'GolfCRM');
});

// ------------------------------------------------------- reading one note

test('the newest note wins, by the date in its name and not by directory order', () => {
  assert.deepEqual(
    pickNewestNote(['session-2026-07-28.md', 'session-2026-07-30.md', 'session-2026-07-29.md']),
    { name: 'session-2026-07-30.md', date: '2026-07-30' },
  );
  // A handover carries a topic suffix, and is a note like any other.
  assert.equal(
    pickNewestNote(['session-2026-07-29.md', 'handover-2026-07-31-ledger.md'])?.name,
    'handover-2026-07-31-ledger.md',
  );
  // Same date, two notes: deterministic rather than whatever readdir returned.
  assert.equal(
    pickNewestNote(['handover-2026-07-29-a.md', 'session-2026-07-29.md'])?.name,
    pickNewestNote(['session-2026-07-29.md', 'handover-2026-07-29-a.md'])?.name,
  );
  assert.equal(pickNewestNote(['README.md', 'notes.md', 'session-not-a-date.md']), null);
  assert.equal(pickNewestNote(null), null);
});

test('a note yields its title, its date and its open threads — and nothing else', () => {
  const digest = noteDigest(NOTE, { name: 'session-2026-07-29.md', date: '2026-07-29' });
  assert.equal(digest.title, 'Bay codes — the timezone fix');
  assert.equal(digest.date, '2026-07-29');
  assert.deepEqual(digest.open, [
    'The DST edge case at 02:00 on the changeover night',
    'Rotate the CI secret that leaked into the build log',
    'bay-daily-codes wants a second pair of eyes',
  ]);
  // The cap is why the fourth bullet is absent, not an accident of the fixture.
  assert.equal(digest.open.length, MAX_OPEN_ITEMS);
});

test('the other sections of the note are unreachable', () => {
  // The privacy line: `## What shipped` and `## Decisions` carry his decisions
  // and a customer's name, and the digest is sent to a third-party endpoint.
  const text = formatVaultDigest('GolfCRM', noteDigest(NOTE, { name: 'session-2026-07-29.md' }));
  for (const secret of ['Backfilled', 'tee_time_utc', 'Andrew', 'legacy', '4,100', 'server']) {
    assert.ok(!text.includes(secret), `leaked from a section that is not Left open: ${secret}`);
  }
  assert.ok(!text.includes('##'), 'no headings travel');
});

test('the digest reads as a memory, and is hard-capped', () => {
  const text = formatVaultDigest('GolfCRM', noteDigest(NOTE, { name: 'session-2026-07-29.md' }));
  assert.equal(
    text,
    'Your notes for GolfCRM — "Bay codes — the timezone fix" (2026-07-29).\n'
    + 'Still open there: The DST edge case at 02:00 on the changeover night; '
    + 'Rotate the CI secret that leaked into the build log; '
    + 'bay-daily-codes wants a second pair of eyes.',
  );
  assert.ok(text.length <= MAX_VAULT_DIGEST_CHARS, `${text.length} chars`);
  assert.equal(text.split('\n').length, 2);
});

test('a long note stays inside the cap, bullet by bullet and overall', () => {
  const long = `# ${'t'.repeat(200)}\n\n## Left open\n${'- ' + 'x'.repeat(300) + '\n'}`.repeat(1);
  const digest = noteDigest(long, { name: 'session-2026-07-29.md', date: '2026-07-29' });
  assert.ok(digest.title.length <= 70, `title ${digest.title.length}`);
  for (const item of digest.open) assert.ok(item.length <= MAX_ITEM_CHARS, `item ${item.length}`);
  const text = formatVaultDigest('GolfCRM', digest);
  assert.ok(text.length <= MAX_VAULT_DIGEST_CHARS, `${text.length} chars`);
});

test('a note with nothing open still says when he last wrote about it', () => {
  const text = formatVaultDigest('GolfCRM', noteDigest('# A quiet day\n\n## What shipped\n- nothing\n', {
    name: 'session-2026-07-29.md',
    date: '2026-07-29',
  }));
  assert.equal(text, 'Your notes for GolfCRM — "A quiet day" (2026-07-29).');
});

test('a numbered, hard-wrapped Left-open list reads as threads, not as nothing', () => {
  // The owner's current convention, checked against the real vault: Salesbridge
  // writes `- `, and his two newest notes write `1.` with the text wrapped at
  // about 80 columns. A dash-only reader returned an empty list for those, and
  // said nothing at all — silently, which is the worst way for this to fail.
  const digest = noteDigest([
    '## Left open',
    '',
    '1. The DST edge case at 02:00 on the changeover night still has no test,',
    '   and the fix in tee_time.ts only papers over it for the northern clubs.',
    '2. Rotate the CI secret that leaked into the build log.',
    '3. Decide whether the backfill runs before or after the release.',
    '4. A fourth thread, which is one too many.',
    '',
    '## Decisions',
    '- something private',
  ].join('\n'), { name: 'session-2026-07-31.md' });

  assert.equal(digest.open.length, MAX_OPEN_ITEMS);
  assert.match(digest.open[0], /^The DST edge case at 02:00 on the changeover night still has no test,/);
  assert.ok(digest.open[0].endsWith('…'), 'a wrapped thread is joined, then honestly cut');
  assert.equal(digest.open[1], 'Rotate the CI secret that leaked into the build log.');
  assert.ok(!digest.open.some((i) => i.includes('private')), 'the next section is not a thread');
  assert.ok(!digest.open.some((i) => i.includes('fourth')));
});

test('the Left-open heading is matched as loosely as the shell hook matches it', () => {
  // session-status.sh has been reading these notes for months with
  // `^## .*[Ll]eft open`. A stricter rule here would find nothing in a note it
  // reads happily, and the failure would be silent.
  for (const heading of ['## Left open', '## What is left open', '## Left open / next session', '#### left open']) {
    const digest = noteDigest(`${heading}\n- the one thing\n`, { name: 'session-2026-07-29.md' });
    assert.deepEqual(digest.open, ['the one thing'], `missed: ${heading}`);
  }
  // A sub-heading inside the section does not end it; the next peer does.
  const nested = noteDigest([
    '## Left open',
    '### tomorrow',
    '- the DST case',
    '## Decisions',
    '- something private',
  ].join('\n'), { name: 'session-2026-07-29.md' });
  assert.deepEqual(nested.open, ['the DST case']);
});

test('a note with no heading falls back to its filename, and no frontmatter to its date', () => {
  const digest = noteDigest('## Left open\n- one thing\n', {
    name: 'handover-2026-07-31-ledger.md',
    date: '2026-07-31',
  });
  assert.equal(digest.title, 'handover-2026-07-31-ledger');
  assert.equal(digest.date, '2026-07-31');
  assert.deepEqual(digest.open, ['one thing']);
});

// --------------------------------------------------------- the exclusion

test('the exclusion list is empty, which is the owner\'s decision and not a default', () => {
  // It held 'Invoco' from the start, because his business notes carry pricing,
  // customer names and grant applications and the digest leaves the machine.
  // He was asked, and on 2026-07-31 he approved Invoco specifically. This
  // assertion is here so that *putting a name back* is also a decision someone
  // takes deliberately, rather than something a passing refactor can do.
  assert.deepEqual([...EXCLUDED_PROJECTS], []);
  assert.ok(!isExcluded('Invoco'), 'Invoco is approved as of 2026-07-31');
  assert.ok(!isExcluded('GolfCRM'));
  assert.ok(!isExcluded(''));
});

test('the exclusion mechanism still works, on a name that is on a list', () => {
  // The list is empty; the machinery is not. Exercised with a synthetic name so
  // this keeps proving the rule whatever the owner later decides to block —
  // matching is normalized, and a name that is not on the list is not excluded.
  const BLOCKED = ['Fictional Project'];
  assert.ok(isExcluded('Fictional Project', BLOCKED));
  assert.ok(isExcluded('fictional-project', BLOCKED), 'case and punctuation cannot be the way around it');
  assert.ok(isExcluded('FICTIONALPROJECT', BLOCKED));
  assert.ok(!isExcluded('GolfCRM', BLOCKED));
  assert.ok(!isExcluded('', BLOCKED), 'no project is not a blocked project');
});

test('a blocked project yields nothing, and its note is never opened', () => {
  // The end-to-end claim, which is the one that matters: the block is checked
  // *before* the file is read, so a blocked note is never opened rather than
  // merely absent from the output. Driven with a synthetic name for the same
  // reason as above — the behaviour is what is pinned here, not the name.
  const BLOCKED = 'Fictional Project';
  const fs = vaultFs({
    tree: {
      [PROJECTS]: ['GolfCRM', 'Invoco', BLOCKED],
      [at(BLOCKED)]: ['session-2026-07-30.md'],
    },
    files: {
      [at(BLOCKED, 'session-2026-07-30.md')]: '# Secret\n\n## Left open\n- the private thing\n',
    },
  });
  const vault = createVault({
    fs,
    projectsDir: PROJECTS,
    mapPath: MAP,
    cwd: `D:\\code\\${BLOCKED}`,
    excludedProjects: [BLOCKED],
  });

  assert.equal(vault.digest(), null);
  assert.ok(
    !fs.reads.some((p) => p.includes(BLOCKED)),
    `opened a blocked file: ${fs.reads.join(', ')}`,
  );
  // And the resolution itself still worked, so this is the block talking and
  // not a mapping that quietly failed.
  assert.equal(vault.stats().project, BLOCKED);
});

test('Invoco is no longer blocked: its notes read like any other project\'s', () => {
  // The other half of the 2026-07-31 approval, and the reason the list is empty.
  // `Invoco-POS` resolves through the map to `Invoco`, and now reads its note.
  const { fs, vault } = vaultFor('C:\\Users\\kw11l\\Desktop\\Invoco-POS');
  assert.equal(vault.stats().project, null, 'nothing is read until something asks');
  assert.equal(vault.digest(), 'Your notes for Invoco — "Pricing" (2026-07-30).\n'
    + 'Still open there: the tier-2 markup.');
  assert.ok(fs.reads.includes(at('Invoco', 'session-2026-07-30.md')));
});

// ------------------------------------------------------------- end to end

test('a mapped project reads its newest note and nothing else', () => {
  const { fs, vault } = vaultFor('C:\\Users\\kw11l\\Desktop\\GolfCRM');
  const text = vault.digest();
  assert.match(text, /^Your notes for GolfCRM — "Bay codes/);
  assert.match(text, /Still open there: The DST edge case/);
  assert.equal(vault.stats().project, 'GolfCRM');
  // One note, not the directory: the older session was never opened.
  assert.ok(!fs.reads.includes(at('GolfCRM', 'session-2026-07-28.md')));
});

test('an Orca worktree under a mapped repo reads that repo\'s notes', () => {
  const { vault } = vaultFor('C:\\Users\\kw11l\\orca\\workspaces\\GolfCRM\\bay-daily-codes');
  assert.match(vault.digest(), /^Your notes for GolfCRM/);
});

test('a project with no folder, no notes, or no vault at all is simply silent', () => {
  // This repo: no map line, no folder. The commonest case, and it must be quiet.
  assert.equal(vaultFor('C:\\Users\\kw11l\\Desktop\\ganyu-pet').vault.digest(), null);
  // A folder that exists but holds no note yet.
  assert.equal(vaultFor('C:\\Users\\kw11l\\Desktop\\salesbridge').vault.digest(), null);
  // No vault directory on this machine.
  const bare = createVault({ fs: fakeFs(), projectsDir: PROJECTS, mapPath: MAP, cwd: 'D:\\GolfCRM' });
  assert.equal(bare.digest(), null);
});

test('every failure is silence, never an exception', () => {
  const unreadable = vaultFor('D:\\GolfCRM', { fs: vaultFs({ fail: { readFileSync: true } }) });
  assert.equal(unreadable.vault.digest(), null);

  const unlistable = vaultFor('D:\\GolfCRM', { fs: vaultFs({ fail: { readdirSync: true } }) });
  assert.equal(unlistable.vault.digest(), null);

  // A cwd getter that throws is no directory, not a crashed chat reply.
  const thrown = vaultFor(() => { throw new Error('no cwd'); });
  assert.equal(thrown.vault.digest(), null);

  // No fs at all: the object still answers every call.
  const none = createVault();
  assert.equal(none.enabled, false);
  assert.equal(none.digest(), null);
  assert.equal(none.stats().enabled, false);
});

test('without the map only the loose match runs, and it still finds a folder', () => {
  const { vault } = vaultFor('D:\\code\\golf crm', { mapPath: null });
  assert.match(vault.digest(), /^Your notes for GolfCRM/);
});

// -------------------------------------------------------------- the cache

test('the disk is read once per TTL, not once per message', () => {
  const { fs, vault, advance } = vaultFor('D:\\GolfCRM');
  assert.ok(vault.digest());
  const afterFirst = fs.reads.length;

  for (let i = 0; i < 5; i += 1) assert.ok(vault.digest());
  assert.equal(fs.reads.length, afterFirst, 'a chat message must not walk the vault');

  advance(VAULT_TTL_MS - 1);
  vault.digest();
  assert.equal(fs.reads.length, afterFirst, 'still inside the window');

  advance(2);
  vault.digest();
  assert.ok(fs.reads.length > afterFirst, 'and re-read once it has expired');
});

test('a null answer is cached too — a missing vault is not re-walked every message', () => {
  const { fs, vault } = vaultFor('C:\\Users\\kw11l\\Desktop\\ganyu-pet');
  assert.equal(vault.digest(), null);
  const listed = fs.listed.length;
  for (let i = 0; i < 5; i += 1) assert.equal(vault.digest(), null);
  assert.equal(fs.listed.length, listed);
});

test('the project follows him: a new cwd is picked up on the next refresh', () => {
  let cwd = 'D:\\code\\ganyu-pet';
  const fs = vaultFs();
  let t = 0;
  const vault = createVault({ fs, projectsDir: PROJECTS, mapPath: MAP, cwd: () => cwd, now: () => t });
  assert.equal(vault.digest(), null);

  cwd = 'D:\\code\\GolfCRM';
  assert.equal(vault.digest(), null, 'the cached miss holds for the whole window');
  t += VAULT_TTL_MS + 1;
  assert.match(vault.digest(), /^Your notes for GolfCRM/);
});
