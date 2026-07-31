// Module D — topics: a map of the owner's *reference* vaults.
//
// vault.mjs reads one vault of one shape: `~/second-brain`, whose
// `03 Projects/<Project>/` folders hold dated `session-YYYY-MM-DD.md` notes, each
// ending in a `## Left open` list. That shape is the whole design there — the
// newest note, and the threads he did not finish.
//
// These two are not that. They are **topic** vaults: `invoco-vault` (engineering
// reference — Architecture, Backend, Database, Features, Frontend) and
// `invoco-vault-strategy` (the business side). Nothing in them is dated, nothing
// in them is a session, and there is no newest note — a topic note is edited in
// place for months. `pickNewestNote` and the Left-open reader have no meaning
// here, so this is a separate module rather than a second mode of that one.
//
// What she needs from them is not their contents. It is **a map of what exists**,
// so that when he asks "where do we document RLS?" she can answer "under
// Database, in Multi-tenancy and RLS" instead of guessing or saying nothing. So
// what is extracted is: the vault's name, its top-level sections, and a small
// sample of note *titles*, path-relative.
//
// PRIVACY — two separate guarantees, and the first is the strong one:
//
//   1. **This module never opens a file.** There is no `readFileSync` call in it
//      and no code path that could reach one; it lists directories and reads the
//      names it is given. A note's contents therefore cannot leak from here, and
//      that claim is about the file rather than about a function — which is the
//      main reason this is not folded into vault.mjs, whose whole job is to open
//      one note and parse it. `test/topics.test.mjs` asserts the fake fs's
//      `readFileSync` was never called.
//   2. `EXCLUDED_FOLDERS` holds back the folders named after real third-party
//      businesses (see the comment there). The owner approved these two vaults on
//      2026-07-31; he did not approve other people's commercial information, and
//      that is a separate decision he has not been asked to make.
//
// No Electron import; `fs`, every path and the clock are injected, so the tests
// drive a fake and never read the real vaults.

import { normalizeName } from './vault.mjs';

/**
 * Folders held back from the map, matched by name at any depth,
 * case-/space-/punctuation-insensitively (`normalizeName`).
 *
 * **The owner approved the two Invoco vaults generally on 2026-07-31. He did not
 * approve the material named after other people's businesses, and this is where
 * that distinction is kept.** These folders' *filenames alone* — which is all
 * this module ever sees — carry named third-party customers:
 *
 *   `01 Sales Pipeline`   — `Pilot_01_Andrew_Family_Business.md`,
 *                           `Pilot_02_Heartland_Literature/`, and inside that a
 *                           stakeholder list, a communications log, call notes
 *                           and two priced proposals. Every one of those names a
 *                           real company that is not his.
 *   `00 Lead Generation`  — today it holds one action-plan note and no customer
 *                           name at all. It is excluded anyway, because a
 *                           lead-generation folder is *by definition* where named
 *                           prospects accumulate: the failure mode to avoid is a
 *                           file called `Pilot_03_<Real Company>.md` appearing
 *                           next month and quietly starting to leave the machine.
 *                           This is the cheap side of the trade — one note.
 *
 * Everything else in both vaults is in scope, including his own finance,
 * marketing, strategy and audit notes.
 *
 * **Re-including one is a single line: delete its entry.** Nothing else changes.
 */
export const EXCLUDED_FOLDERS = Object.freeze(['01 Sales Pipeline', '00 Lead Generation']);

/**
 * How long a reading stays fresh. Six times vault.mjs's, deliberately: a session
 * note is written a few times a day and is interesting the moment it lands,
 * whereas a topic vault gains a note every week or two and the map is no less
 * true for being an hour old. The walk is also the more expensive of the two —
 * a few dozen directory listings against one listing and one file — and it sits
 * behind a chat message he is waiting on. A null result is cached too, so a
 * machine without these vaults does not re-walk a missing directory per message.
 */
export const TOPICS_TTL_MS = 60 * 60 * 1000;

/** Per-vault cap. This goes in a prompt beside the ledger's digest and the vault's. */
export const MAX_TOPIC_DIGEST_CHARS = 400;

/** Both vaults together. Two full blocks plus the newline between them. */
export const MAX_TOPICS_DIGEST_CHARS = MAX_TOPIC_DIGEST_CHARS * 2 + 1;

/** Breadth over depth: the section names are the answer, the titles are the sample. */
export const MAX_SECTIONS = 8;
export const MAX_TITLES = 6;
export const MAX_SECTION_CHARS = 30;
export const MAX_TITLE_CHARS = 46;
export const MAX_LABEL_CHARS = 40;

/**
 * How far down a vault is walked, and how much of it is looked at.
 *
 * Depth 3 reaches `business/strategy/<note>.md` and stops before the vendored
 * `anthropic-fsi-reference/` tree underneath it, which is 20 files of someone
 * else's published reference material and none of his notes. `MAX_ENTRIES` is the
 * backstop for a directory that turns out to be far bigger than either of these:
 * the walk stops, and the map is simply built from what it had.
 */
export const MAX_DEPTH = 3;
export const MAX_ENTRIES = 600;

/** Only a note counts as a note. `.canvas`, `.png`, `.html` attachments do not. */
const NOTE_RE = /\.md$/i;

/** One line, collapsed, trimmed, hard-capped. Empty and non-strings are null. */
function shortText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * `<dir>/<name>`, keeping whichever separator the caller already used. A local
 * copy of vault.mjs's, rather than an import of a private helper, for the same
 * reason it exists there: a path built here must be byte-identical to the one a
 * test put in its fake fs, on any platform.
 */
function join(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '');
  return `${base}${base.includes('\\') ? '\\' : '/'}${name}`;
}

/** Whether this folder is held back. See EXCLUDED_FOLDERS. */
export function isExcludedFolder(name) {
  const key = normalizeName(name);
  if (key === '') return false;
  return EXCLUDED_FOLDERS.some((folder) => normalizeName(folder) === key);
}

/** Deterministic, and not whatever order `readdir` happened to return. */
function byName(a, b) {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.name < b.name ? -1 : 1;
}

/**
 * One directory as `[{name, dir}]`, sorted, never throwing.
 *
 * `withFileTypes` is asked for because that is the one call that says which
 * entries are directories. An fs shim that ignores the option and returns plain
 * strings still works: a name ending in an extension is a file, anything else is
 * a directory — which is exactly right for a vault, where the only files are
 * notes and attachments.
 */
function entriesOf(fs, dir) {
  let raw;
  try {
    raw = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item !== '') out.push({ name: item, dir: !/\.[a-z0-9]+$/i.test(item) });
      continue;
    }
    const name = String(item?.name ?? '');
    if (name === '') continue;
    out.push({ name, dir: typeof item?.isDirectory === 'function' ? item.isDirectory() : false });
  }
  return out.sort(byName);
}

/**
 * `scanVault(fs, dir)` -> `{sections, titles, noteCount}` or null.
 *
 * `sections` are the vault's top-level directories, which is what a question like
 * "where do we document RLS?" is actually asking about. `titles` are note paths
 * relative to the vault root, with `.md` dropped — bucketed by their top-level
 * section and sampled round-robin, so six titles cover six sections rather than
 * six notes in whichever folder happened to sort first. Notes sitting loose at
 * the root (`00 - Index.md`, `Glossary.md`) get a bucket of their own, taken last.
 *
 * Dot-directories (`.git`, `.obsidian`, `.claude`) and the folders in
 * EXCLUDED_FOLDERS are never descended into. Null means the directory could not
 * be listed at all — no such vault on this machine, which is the common case.
 */
export function scanVault(fs, dir) {
  const top = entriesOf(fs, dir);
  if (top.length === 0) return null;

  const sections = [];
  // Insertion order is the sampling order: the sections first, root notes last.
  const buckets = new Map();
  let noteCount = 0;
  let seen = 0;

  const walk = (here, prefix, depth, bucket) => {
    for (const item of entriesOf(fs, here)) {
      if (seen >= MAX_ENTRIES) return;
      seen += 1;
      if (item.name.startsWith('.')) continue;
      if (item.dir) {
        if (isExcludedFolder(item.name) || depth >= MAX_DEPTH) continue;
        walk(join(here, item.name), `${prefix}${item.name}/`, depth + 1, bucket);
        continue;
      }
      if (!NOTE_RE.test(item.name)) continue;
      noteCount += 1;
      const title = shortText(`${prefix}${item.name.replace(NOTE_RE, '')}`, MAX_TITLE_CHARS);
      if (title && bucket.length < MAX_TITLES) bucket.push(title);
    }
  };

  const rootNotes = [];
  for (const item of top) {
    if (item.name.startsWith('.') || !item.dir || isExcludedFolder(item.name)) continue;
    const name = shortText(item.name, MAX_SECTION_CHARS);
    if (!name) continue;
    const bucket = [];
    buckets.set(item.name, bucket);
    if (sections.length < MAX_SECTIONS) sections.push(name);
    walk(join(dir, item.name), `${item.name}/`, 1, bucket);
  }
  buckets.set('', rootNotes);
  for (const item of top) {
    if (item.dir || item.name.startsWith('.') || !NOTE_RE.test(item.name)) continue;
    noteCount += 1;
    const title = shortText(item.name.replace(NOTE_RE, ''), MAX_TITLE_CHARS);
    if (title && rootNotes.length < MAX_TITLES) rootNotes.push(title);
  }

  const titles = [];
  const lists = [...buckets.values()];
  for (let i = 0; titles.length < MAX_TITLES; i += 1) {
    let found = false;
    for (const list of lists) {
      if (i >= list.length) continue;
      titles.push(list[i]);
      found = true;
      if (titles.length >= MAX_TITLES) break;
    }
    if (!found) break;
  }

  return noteCount === 0 && sections.length === 0 ? null : { sections, titles, noteCount };
}

/** `a, b and c` */
function joinList(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The two lines' own caps, summing (plus the newline) to MAX_TOPIC_DIGEST_CHARS. */
const HEAD_CHARS = 150;
const TITLES_CHARS = MAX_TOPIC_DIGEST_CHARS - HEAD_CHARS - 1;

/**
 * The prompt block for one vault, as she would have it in her head. Two lines at
 * most, capped — it sits beside the ledger's digest and the session vault's, and
 * long context makes her worse:
 *
 *   Your Invoco engineering notes — 57 notes under Architecture, Backend, …
 *   Notes there include: Architecture/01 - System Topology; Backend/Cron Jobs; …
 *
 * Null when there is nothing to say. A vault with sections but no sampled title
 * still yields its first line: knowing the vault exists and what it is divided
 * into is most of the answer to "where is that written down".
 */
export function formatTopicDigest(label, scan) {
  const name = shortText(label, MAX_LABEL_CHARS);
  if (!name || !scan) return null;
  const where = scan.sections.length ? ` under ${joinList(scan.sections)}` : '';
  const head = scan.noteCount > 0
    ? `Your ${name} — ${plural(scan.noteCount, 'note')}${where}.`
    : `Your ${name}${where || ''}.`;
  const lines = [shortText(head, HEAD_CHARS)];
  if (scan.titles.length) {
    lines.push(shortText(`Notes there include: ${scan.titles.join('; ')}.`, TITLES_CHARS));
  }
  return lines.filter(Boolean).join('\n') || null;
}

/**
 * createTopics({fs, vaults, now, ttlMs})
 *
 * fs     — node:fs shaped: readdirSync (with `{withFileTypes:true}`), and
 *          optionally existsSync. **readFileSync is never called.**
 * vaults — `[{dir, label}]`. `label` is how she names it ("Invoco engineering
 *          notes"); without one the directory's last segment is used. A vault
 *          whose directory is absent contributes nothing and is not an error.
 * now    — () => ms, injected so the TTL is testable.
 * ttlMs  — how long a reading is reused.
 *
 * Returns `{enabled, digest(), stats()}`. `digest()` is lazy — nothing is walked
 * until something asks — and **every** failure resolves to null: no fs, no
 * vaults configured, no directory, an unlistable directory, an empty vault. Null
 * is the pre-existing behaviour on any machine without these clones, which is
 * the whole fallback story: she simply does not mention them.
 */
export function createTopics({
  fs = null,
  vaults = [],
  now = Date.now,
  ttlMs = TOPICS_TTL_MS,
} = {}) {
  const clock = () => {
    const t = Number(typeof now === 'function' ? now() : now);
    return Number.isFinite(t) ? t : Date.now();
  };

  const configured = (Array.isArray(vaults) ? vaults : [])
    .map((v) => ({
      dir: typeof v?.dir === 'string' && v.dir.trim() !== '' ? v.dir : null,
      label: typeof v?.label === 'string' && v.label.trim() !== '' ? v.label.trim() : null,
    }))
    .filter((v) => v.dir !== null);

  const usable = Boolean(fs) && typeof fs.readdirSync === 'function' && configured.length > 0;

  let cached = null; // {at, text, found}
  let walks = 0;

  /** The vault's own name when the caller did not give it one. */
  const labelFor = (vault) => vault.label
    ?? String(vault.dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    ?? 'notes';

  /**
   * One trip to the disk, across every configured vault. Never throws.
   *
   * The overall cap is applied by dropping a whole vault rather than by cutting
   * the joined text: each block is two lines that mean something together, and a
   * character-count slice would leave her holding half a sentence about a vault.
   * With the two vaults he has, nothing is ever dropped — `MAX_TOPICS_DIGEST_CHARS`
   * is two full blocks — so this only bites if a third is ever configured.
   */
  function refresh() {
    walks += 1;
    const blocks = [];
    const found = [];
    let chars = 0;
    for (const vault of configured) {
      if (typeof fs.existsSync === 'function' && !fs.existsSync(vault.dir)) continue;
      const scan = scanVault(fs, vault.dir);
      if (!scan) continue;
      const label = labelFor(vault);
      const block = formatTopicDigest(label, scan);
      if (!block) continue;
      const cost = block.length + (blocks.length ? 1 : 0);
      if (chars + cost > MAX_TOPICS_DIGEST_CHARS) continue;
      chars += cost;
      blocks.push(block);
      found.push(label);
    }
    return { at: clock(), found, text: blocks.length ? blocks.join('\n') : null };
  }

  if (!usable) {
    return {
      enabled: false,
      digest: () => null,
      stats: () => ({ enabled: false, vaults: [], walks: 0, cachedAt: null }),
    };
  }

  return {
    enabled: true,
    /** The block for the chat briefing, or null. Cached for `ttlMs`, nulls included. */
    digest() {
      const t = clock();
      const ttl = Number(ttlMs);
      const fresh = cached && Number.isFinite(ttl) && t - cached.at < ttl;
      if (!fresh) cached = refresh();
      return cached.text;
    },
    /** Introspection for tests and debugging. Carries no note titles. */
    stats() {
      return {
        enabled: true,
        vaults: cached?.found ?? [],
        walks,
        cachedAt: cached?.at ?? null,
      };
    },
  };
}

export default createTopics;
