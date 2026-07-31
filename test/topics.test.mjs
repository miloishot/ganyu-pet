// Topics tests — the map of the owner's two Invoco reference vaults.
//
// `fs` is injected and every path below is invented, so **nothing here reads the
// real vaults**, exactly as in vault.test.mjs and for the same reason. The
// fixtures mirror the real trees closely enough to be worth trusting — the
// section names, the excluded folders and the shape of the third-party material
// are copied from what is actually on disk — but not one byte comes from it.
//
// Four themes:
//   1. the map — a vault becomes a name, a list of sections and a *sample* of
//      note titles, sampled for breadth rather than depth;
//   2. privacy — the folders named after real customers are held back, and the
//      module provably never opens a file;
//   3. bounds — a vault of any size yields a block that fits in a prompt;
//   4. degradation — no vault, no fs, an unlistable directory: null, never a throw.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXCLUDED_FOLDERS,
  MAX_TITLES,
  MAX_TOPICS_DIGEST_CHARS,
  MAX_TOPIC_DIGEST_CHARS,
  TOPICS_TTL_MS,
  createTopics,
  formatTopicDigest,
  isExcludedFolder,
  scanVault,
} from '../src/main/topics.mjs';

const ENG = 'C:\\Users\\kw11l\\invoco-vault';
const BIZ = 'C:\\Users\\kw11l\\invoco-vault-strategy';

/** `dir` + one more segment, in the fixture's own separator. */
const at = (...parts) => parts.join('\\');

/**
 * node:fs shrunk to the one call topics.mjs makes. `tree` is directory -> entry
 * names; a name ending in an extension is a file, everything else a directory,
 * which is what `withFileTypes` would have told us.
 *
 * `reads` exists to be asserted **empty**: readFileSync is present so that a
 * call to it would succeed and be recorded rather than throwing and being
 * mistaken for ordinary degradation.
 */
function fakeFs(tree = {}, { fail = false } = {}) {
  const reads = [];
  const listed = [];
  return {
    reads,
    listed,
    existsSync: (p) => Object.hasOwn(tree, p),
    readdirSync(p, options) {
      listed.push(p);
      if (fail) throw new Error('readdirSync refused');
      if (!Object.hasOwn(tree, p)) throw new Error(`ENOENT ${p}`);
      const names = [...tree[p]];
      if (!options?.withFileTypes) return names;
      return names.map((name) => ({ name, isDirectory: () => !/\.[a-z0-9]+$/i.test(name) }));
    },
    readFileSync(p) {
      reads.push(p);
      return 'the contents of a note, which must never be asked for';
    },
  };
}

/** The engineering vault, shaped like the real one. */
const ENG_TREE = {
  [ENG]: ['.git', '.obsidian', '00 - Index.md', 'Architecture', 'Backend', 'Database',
    'Decision Log.md', 'Features', 'Frontend', 'Glossary.md', 'Operations', 'Personas', 'Roadmap.md'],
  [at(ENG, 'Architecture')]: ['01 - System Topology.md', 'Backend Stack.md', 'Cloudflare and Tunnel.md'],
  [at(ENG, 'Backend')]: ['Cron Jobs.md', 'Edge Functions Inventory.md'],
  [at(ENG, 'Database')]: ['Multi-tenancy and RLS.md', 'RPC Catalogue.md', 'Schema Map.md'],
  [at(ENG, 'Features')]: ['Admin Panel.md', 'AI Agent.md', 'POS Terminal.md', 'QR Ordering.md'],
  [at(ENG, 'Frontend')]: ['Hooks Catalogue.md', 'Routing Map.md'],
  [at(ENG, 'Operations')]: ['Backup and Recovery.md', 'Security Posture.md'],
  [at(ENG, 'Personas')]: ['Customer Persona.md'],
  [at(ENG, '.git')]: ['HEAD', 'config'],
  [at(ENG, '.obsidian')]: ['app.json'],
};

/**
 * The business vault. `01 Sales Pipeline` and `00 Lead Generation` carry the
 * names of real companies — that is the whole reason EXCLUDED_FOLDERS exists,
 * so the fixture has to contain something that would be recognisably wrong if
 * it ever came out.
 */
const BIZ_TREE = {
  [BIZ]: ['.git', '.obsidian', 'CLAUDE.md', 'Operations', 'business', 'technical'],
  [at(BIZ, 'business')]: ['00 Lead Generation', '01 Sales Pipeline', 'Decision Log.md',
    'audits', 'finance', 'marketing', 'strategy'],
  [at(BIZ, 'business', '00 Lead Generation')]: ['Lead_Gen_Action_Plan.md', 'Prospect_Acme_Noodle_House.md'],
  [at(BIZ, 'business', '01 Sales Pipeline')]: ['Pilot_01_Andrew_Family_Business.md', 'Pilot_02_Heartland_Literature'],
  [at(BIZ, 'business', '01 Sales Pipeline', 'Pilot_02_Heartland_Literature')]:
    ['(C) 01-stakeholders.md', '(C) 03-communications-log.md', '(C) 08-proposal-v2-DRAFT.md'],
  [at(BIZ, 'business', 'audits')]: ['2026-05-07-gap-tickets.md'],
  [at(BIZ, 'business', 'finance')]: ['legal-fee-quotes.md', 'safe-undersubscription-scenario.md'],
  [at(BIZ, 'business', 'marketing')]: ['my-consultant-scaling.md'],
  [at(BIZ, 'business', 'strategy')]: ['2026-05-05-invoco-strategic-master-plan.md', 'cohort-accounting.md'],
  [at(BIZ, 'Operations')]: ['contributors.md'],
  [at(BIZ, 'technical')]: ['00 - Index.md', 'Database'],
  [at(BIZ, 'technical', 'Database')]: ['Multi-tenancy and RLS.md'],
  [at(BIZ, '.git')]: ['HEAD'],
  [at(BIZ, '.obsidian')]: ['app.json'],
};

const bothVaults = () => fakeFs({ ...ENG_TREE, ...BIZ_TREE });

function topicsFor(fs = bothVaults(), opts = {}) {
  let t = opts.start ?? 1_000_000;
  const topics = createTopics({
    fs,
    vaults: opts.vaults ?? [
      { dir: ENG, label: 'Invoco engineering notes' },
      { dir: BIZ, label: 'Invoco business notes' },
    ],
    now: () => t,
    ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
  });
  return { fs, topics, advance: (ms) => { t += ms; } };
}

// ----------------------------------------------------------------- the map

test('a vault becomes its sections and a breadth-first sample of note titles', () => {
  const scan = scanVault(fakeFs(ENG_TREE), ENG);
  assert.deepEqual(scan.sections,
    ['Architecture', 'Backend', 'Database', 'Features', 'Frontend', 'Operations', 'Personas']);
  assert.equal(scan.noteCount, 21, 'every note counts, even the ones no title is sampled from');

  // One title from each section before a second from any of them: six titles
  // that cover six sections beat six notes out of whichever folder sorted first.
  assert.deepEqual(scan.titles, [
    'Architecture/01 - System Topology',
    'Backend/Cron Jobs',
    'Database/Multi-tenancy and RLS',
    'Features/Admin Panel',
    'Frontend/Hooks Catalogue',
    'Operations/Backup and Recovery',
  ]);
  assert.equal(scan.titles.length, MAX_TITLES);
});

test('titles are path-relative, so a title says which section it is in', () => {
  // The whole point of the feature: "where do we document RLS?" is answerable
  // only if the section travels with the name.
  const scan = scanVault(fakeFs(ENG_TREE), ENG);
  assert.ok(scan.titles.includes('Database/Multi-tenancy and RLS'));
  assert.ok(scan.titles.every((t) => !t.endsWith('.md')), 'the extension is noise');
  assert.ok(scan.titles.every((t) => !t.includes(ENG)), 'no absolute path travels');
});

test('dot-directories are not sections and their files are not notes', () => {
  const scan = scanVault(fakeFs(ENG_TREE), ENG);
  assert.ok(!scan.sections.includes('.git'));
  assert.ok(!scan.sections.includes('.obsidian'));
  assert.ok(!scan.titles.some((t) => t.startsWith('.')), scan.titles.join(', '));
});

test('root notes are counted and sampled, but only after every section has had one', () => {
  // `00 - Index.md`, `Glossary.md`, `Roadmap.md`, `Decision Log.md` belong to no
  // section. They are real notes, so they count — but a section name is worth
  // more to her than a loose file, so they are taken last and here never reached.
  const scan = scanVault(fakeFs(ENG_TREE), ENG);
  assert.ok(!scan.titles.includes('00 - Index'));
  const small = scanVault(fakeFs({ [ENG]: ['00 - Index.md', 'Roadmap.md'] }), ENG);
  assert.deepEqual(small.sections, []);
  assert.deepEqual(small.titles, ['00 - Index', 'Roadmap']);
});

// ------------------------------------------------------------- the privacy

test('the folders named after real customers are excluded, and it is a constant', () => {
  // The owner approved the two Invoco vaults on 2026-07-31. He did not approve
  // other people's commercial information, and that is a separate decision he
  // has not been asked to make. If this list is ever emptied, that must be his
  // call, and this test is where it gets noticed.
  assert.deepEqual([...EXCLUDED_FOLDERS], ['01 Sales Pipeline', '00 Lead Generation']);
  assert.ok(isExcludedFolder('01 Sales Pipeline'));
  assert.ok(isExcludedFolder('01-sales-pipeline'), 'punctuation cannot be the way around it');
  assert.ok(isExcludedFolder('00 Lead Generation'));
  assert.ok(!isExcludedFolder('finance'));
  assert.ok(!isExcludedFolder(''));
});

test('no customer name reaches the digest, from the folder name or from inside it', () => {
  const fs = fakeFs(BIZ_TREE);
  const text = formatTopicDigest('Invoco business notes', scanVault(fs, BIZ));
  for (const name of ['Andrew', 'Heartland', 'Acme', 'Noodle', 'Pilot_01', 'Pilot_02',
    'Sales Pipeline', 'Lead Generation', 'stakeholders', 'communications-log', 'proposal']) {
    assert.ok(!text.includes(name), `leaked third-party material: ${name}\n${text}`);
  }
  // The stronger claim: an excluded folder is never descended into at all, so a
  // file added inside one next month cannot appear either.
  assert.ok(
    !fs.listed.some((p) => p.includes('Sales Pipeline') || p.includes('Lead Generation')),
    `listed an excluded folder: ${fs.listed.join(', ')}`,
  );
  // His own material is in scope, which is the other half of the decision.
  assert.ok(text.includes('business'), text);
});

test('an excluded folder is not counted either — the number is of what she may see', () => {
  const scan = scanVault(fakeFs(BIZ_TREE), BIZ);
  // 1 CLAUDE + 1 Operations + 8 business (Decision Log, audits 1, finance 2,
  // marketing 1, strategy 2 — and nothing from the two excluded folders)
  // + 2 technical.
  assert.equal(scan.noteCount, 11);
});

test('this module never opens a file — that is the guarantee, not a side effect', () => {
  // vault.mjs reads a note and parses it, so its privacy story is about what a
  // function extracts. This module's is about the file: there is no readFileSync
  // call in it, and a note's contents therefore cannot leak from here at all.
  const { fs, topics } = topicsFor();
  assert.ok(topics.digest());
  assert.deepEqual(fs.reads, [], `opened a file: ${fs.reads.join(', ')}`);
});

// -------------------------------------------------------------- the digest

test('the digest names the vault, its sections, and a few of its notes', () => {
  const text = formatTopicDigest('Invoco engineering notes', scanVault(fakeFs(ENG_TREE), ENG));
  assert.equal(
    text,
    'Your Invoco engineering notes — 21 notes under Architecture, Backend, Database, '
    + 'Features, Frontend, Operations and Personas.\n'
    + 'Notes there include: Architecture/01 - System Topology; Backend/Cron Jobs; '
    + 'Database/Multi-tenancy and RLS; Features/Admin Panel; Frontend/Hooks Catalogue; '
    + 'Operations/Backup and Recovery.',
  );
  assert.equal(text.split('\n').length, 2);
  assert.ok(text.length <= MAX_TOPIC_DIGEST_CHARS, `${text.length} chars`);
});

test('a huge vault still fits in a prompt, section by section and overall', () => {
  const many = Object.fromEntries([
    [ENG, Array.from({ length: 40 }, (_, i) => `Section ${'S'.repeat(60)}${i}`)],
    ...Array.from({ length: 40 }, (_, i) => [
      at(ENG, `Section ${'S'.repeat(60)}${i}`),
      Array.from({ length: 30 }, (_, j) => `${'a note with a very long name '.repeat(4)}${j}.md`),
    ]),
  ]);
  const scan = scanVault(fakeFs(many), ENG);
  const text = formatTopicDigest('a vault with an extremely long name indeed', scan);
  assert.ok(text.length <= MAX_TOPIC_DIGEST_CHARS, `${text.length} chars: ${text}`);
  assert.ok(text.split('\n').length <= 2);
});

test('both vaults together stay inside the combined cap', () => {
  const { topics } = topicsFor();
  const text = topics.digest();
  assert.ok(text.includes('Your Invoco engineering notes'), text);
  assert.ok(text.includes('Your Invoco business notes'), text);
  assert.ok(text.length <= MAX_TOPICS_DIGEST_CHARS, `${text.length} chars`);
});

test('a vault with no label is named after its own directory', () => {
  const { topics } = topicsFor(fakeFs(ENG_TREE), { vaults: [{ dir: ENG }] });
  assert.match(topics.digest(), /^Your invoco-vault — /);
});

// --------------------------------------------------------- the degradation

test('a vault that is not on this machine is simply absent, not an error', () => {
  // The common case on any other machine, and the one that must stay quiet.
  const { topics } = topicsFor(fakeFs(ENG_TREE));
  const text = topics.digest();
  assert.ok(text.includes('engineering'));
  assert.ok(!text.includes('business'), 'the missing vault contributes nothing');
  assert.deepEqual(topics.stats().vaults, ['Invoco engineering notes']);
});

test('every failure is silence, never an exception', () => {
  assert.equal(topicsFor(fakeFs({})).topics.digest(), null);
  assert.equal(topicsFor(fakeFs(ENG_TREE, { fail: true })).topics.digest(), null);
  assert.equal(topicsFor(bothVaults(), { vaults: [] }).topics.enabled, false);
  assert.equal(topicsFor(bothVaults(), { vaults: [{ dir: '  ' }] }).topics.enabled, false);

  const none = createTopics();
  assert.equal(none.enabled, false);
  assert.equal(none.digest(), null);
  assert.equal(none.stats().enabled, false);
});

test('an fs that ignores withFileTypes still yields the same map', () => {
  // The fallback exists because the one call that says "this is a directory" is
  // the one an fs shim is most likely to simplify away. `.md` is the discriminator
  // either way, and in a vault the only files are notes and attachments.
  const strings = {
    ...fakeFs(ENG_TREE),
    readdirSync(p) {
      if (!Object.hasOwn(ENG_TREE, p)) throw new Error(`ENOENT ${p}`);
      return [...ENG_TREE[p]];
    },
  };
  assert.deepEqual(scanVault(strings, ENG).sections, scanVault(fakeFs(ENG_TREE), ENG).sections);
});

// ---------------------------------------------------------------- the cache

test('the disk is walked once per TTL, not once per message', () => {
  const { fs, topics, advance } = topicsFor();
  assert.ok(topics.digest());
  const afterFirst = fs.listed.length;

  for (let i = 0; i < 5; i += 1) assert.ok(topics.digest());
  assert.equal(fs.listed.length, afterFirst, 'a chat message must not walk two vaults');

  advance(TOPICS_TTL_MS - 1);
  topics.digest();
  assert.equal(fs.listed.length, afterFirst, 'still inside the window');

  advance(2);
  topics.digest();
  assert.ok(fs.listed.length > afterFirst, 'and re-walked once it has expired');
  assert.equal(topics.stats().walks, 2);
});

test('a null answer is cached too — absent vaults are not re-walked every message', () => {
  const { fs, topics } = topicsFor(fakeFs({}));
  assert.equal(topics.digest(), null);
  const listed = fs.listed.length;
  for (let i = 0; i < 5; i += 1) assert.equal(topics.digest(), null);
  assert.equal(fs.listed.length, listed);
});
