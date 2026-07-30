// Module D — vault: the owner's own notes about the project he is sitting in.
//
// The ledger (ledger.mjs) is what *she* saw. This is what *he* wrote down: the
// second-brain vault at `~/second-brain`, an Obsidian repo whose
// `03 Projects/<Project>/` folders hold `session-YYYY-MM-DD.md` and
// `handover-YYYY-MM-DD-<topic>.md` notes, each ending in a `## Left open`
// section listing the threads he did not finish. That list is the answer to
// "what was I in the middle of", and until now the pet could not see it.
//
// Which vault project a repo maps to is not guessable — `Invoco-POS` files
// under `Invoco`, `zmk-new_corne` under `Corne Keyboard` — so the mapping is
// read from the same `~/.claude/hooks/projects.tsv` the shell hooks read,
// rather than duplicated here where the two copies would drift. A repo with no
// line in that file still resolves if its directory name already matches a
// project folder, case/space/punctuation aside — the same loose fallback
// `hooks/lib.sh` uses.
//
// PRIVACY — this is the owner's private writing, and the digest is sent to a
// third-party endpoint, so the extraction is deliberately narrow: **the note
// title, its date, and the `Left open` bullets. Nothing else.** Not the body,
// not the decisions, not the other sections, never the file. Two things enforce
// that: `noteDigest` builds its result out of three named pieces and never
// carries the source text forward, and `EXCLUDED_PROJECTS` removes one project
// from the feature entirely (see the comment there — it is a policy decision).
//
// No Electron import; `fs`, both paths and the clock are injected, so the tests
// drive a fake and never read the real vault.

import { projectFromCwd } from './context.mjs';

/**
 * Projects that are never read, whatever the map says and whatever directory
 * he happens to be in.
 *
 * **This is a deliberate policy choice, not an oversight, and not a stub to be
 * tidied away.** Invoco notes carry the owner's business material — pricing,
 * unit economics, customer names, grant applications — and the digest built
 * here leaves the machine for a third-party endpoint. He has not been asked
 * whether that is acceptable, and until he is, the answer is no. Taking a name
 * off this list is his decision to make, not a refactor: it changes what leaves
 * his machine.
 */
export const EXCLUDED_PROJECTS = Object.freeze(['Invoco']);

/**
 * How long a reading stays fresh. The vault changes when he writes a note,
 * which is a few times a day; the disk read is one small directory listing and
 * one file, but it sits behind a chat message he is waiting on, so it is worth
 * not repeating. A null result is cached too — a machine with no vault must not
 * re-walk a missing directory on every message.
 */
export const VAULT_TTL_MS = 10 * 60 * 1000;

/** The digest goes into a prompt beside the ledger's, so it is capped like it. */
export const MAX_VAULT_DIGEST_CHARS = 300;

/** An open thread is a clause. More than three is a backlog, and unreadable. */
export const MAX_OPEN_ITEMS = 3;
export const MAX_ITEM_CHARS = 90;
export const MAX_TITLE_CHARS = 70;

/** `session-2026-07-30.md`, `handover-2026-07-30-ledger.md`. Nothing else is a note. */
const NOTE_RE = /^(?:session|handover)-(\d{4}-\d{2}-\d{2})(?:-.*)?\.md$/i;

/**
 * The section heading, and where a section ends.
 *
 * `LEFT_OPEN_RE` deliberately matches the *whole* heading text rather than
 * anchoring at "Left open", because `session-status.sh` — which has been
 * reading these same notes for months — matches `^## .*[Ll]eft open`, and a
 * stricter rule here would silently find nothing in a note the shell hook
 * reads happily ("## What is left open", "## Left open / next session").
 *
 * A section ends at the next heading of the same depth or shallower, so a
 * `### ` grouping *inside* Left open does not truncate the list.
 */
const LEFT_OPEN_RE = /^#{1,6}\s+.*left\s+open/i;
const HEADING_RE = /^(#{1,6})\s/;

/**
 * One open thread. **Numbered as well as dashed**, and that is not defensive
 * programming — checked against the real vault, `Salesbridge` writes `- ` and
 * the two newest notes (`GolfCRM`, `Ganyu Pet`) write `1.`, so a dash-only rule
 * reads the owner's current convention as an empty list and says nothing at
 * all. A marker indented by more than one space is a sub-point, not a thread.
 */
const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/** Those notes wrap at ~80 columns, so an item is a marker line plus its tail. */
const MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** One line, collapsed, trimmed, hard-capped. Empty and non-strings are null. */
function shortText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * `<dir>/<name>`, keeping whichever separator the caller already used. Local
 * rather than `node:path.join` so a path built here is byte-identical to the
 * one a test put in its fake fs, on any platform.
 */
function join(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '');
  return `${base}${base.includes('\\') ? '\\' : '/'}${name}`;
}

/**
 * Case, space and punctuation removed, so `bay-daily codes`, `BayDailyCodes`
 * and `bay_daily_codes` are one name. Mirrors `tr -d ' -_'` in hooks/lib.sh.
 */
export function normalizeName(name) {
  return String(name ?? '').toLowerCase().replace(/[\s\-_.]+/g, '');
}

/**
 * `parseProjectMap(text)` — the TAB-separated `repo-dir<TAB>vault-project`
 * lines of `projects.tsv` as a Map. Blank lines and `#` comments are skipped,
 * exactly as the shell reads it.
 */
export function parseProjectMap(text) {
  const map = new Map();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab).trim();
    const value = line.slice(tab + 1).trim();
    if (key !== '' && value !== '') map.set(key, value);
  }
  return map;
}

/**
 * The repo directory an event happened in. `context.projectFromCwd` keeps
 * `<repo>/<worktree>` for an Orca worktree, which is right for speech and wrong
 * here: `bay-daily-codes` has no vault folder of its own, its notes are filed
 * under the repo's.
 */
export function repoNameFromCwd(cwd) {
  const project = projectFromCwd(cwd);
  if (!project) return null;
  const slash = project.indexOf('/');
  return slash === -1 ? project : project.slice(0, slash);
}

/**
 * `resolveProject({cwd, map, projectDirs})` — the vault project for this
 * directory, or null.
 *
 * Explicit map first, then the loose match against the folders that actually
 * exist, so a project whose repo is already named after its vault folder needs
 * no line in the file. Same order as `vault_project_for` in hooks/lib.sh.
 */
export function resolveProject({ cwd = null, map = null, projectDirs = [] } = {}) {
  const here = repoNameFromCwd(cwd);
  if (!here) return null;

  const mapped = map instanceof Map ? map.get(here) : null;
  if (mapped) return mapped;

  const want = normalizeName(here);
  if (want === '') return null;
  for (const dir of Array.isArray(projectDirs) ? projectDirs : []) {
    if (normalizeName(dir) === want) return String(dir);
  }
  return null;
}

/** Whether this project's notes may be read at all. See EXCLUDED_PROJECTS. */
export function isExcluded(project) {
  const key = normalizeName(project);
  if (key === '') return false;
  return EXCLUDED_PROJECTS.some((name) => normalizeName(name) === key);
}

/**
 * `pickNewestNote(names)` — `{name, date}` for the newest note, by the date in
 * the filename rather than by mtime: the date is what the note is *about*, and
 * a file touched by a rebase is not a newer note. Two notes of the same date
 * are broken by name, so the choice is deterministic rather than
 * directory-order dependent.
 */
export function pickNewestNote(names) {
  let best = null;
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '');
    const match = NOTE_RE.exec(name);
    if (!match) continue;
    const date = match[1];
    if (!best || date > best.date || (date === best.date && name > best.name)) {
      best = { name, date };
    }
  }
  return best;
}

/** `[[wikilink]]` and `**bold**` are Obsidian's, not English. */
function plainText(text) {
  return String(text ?? '')
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target, label) => label || target)
    .replace(/[*_`]+/g, '')
    .replace(/^\[[ xX]\]\s*/, '');
}

/**
 * `noteDigest(text, {name, date})` -> `{title, date, open: [...]}`
 *
 * **The privacy gate.** The result is built from three named pieces and the
 * source text is never carried forward, so a section this function does not
 * know about cannot reach the caller — the same construction the ledger's
 * `sanitizeEntry` uses, for the same reason.
 *
 * `title` is the first `# ` heading, falling back to the filename; `date` is
 * the frontmatter's, falling back to the filename's; `open` is the bullets
 * under `## Left open`, stopping at the next heading.
 */
export function noteDigest(text, { name = '', date = null } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);

  let title = null;
  let frontmatterDate = null;
  let inFrontmatter = false;
  let openDepth = 0; // 0 while outside the section; the heading's depth inside it
  const open = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false;
      else {
        const match = /^date:\s*(.+)$/i.exec(line.trim());
        if (match && !frontmatterDate) frontmatterDate = shortText(match[1].replace(/['"]/g, ''), 20);
      }
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (!title && heading[1] === '#') {
        title = shortText(plainText(line.replace(/^#\s+/, '')), MAX_TITLE_CHARS);
      }
      const depth = heading[1].length;
      if (LEFT_OPEN_RE.test(line)) openDepth = depth;
      else if (openDepth && depth <= openDepth) openDepth = 0;
      continue;
    }
    if (!openDepth) continue;

    const item = ITEM_RE.exec(line);
    if (item && item[1].length <= 1) {
      // The fourth thread ends the reading rather than being dropped one line
      // at a time: nothing after it can belong to a thread she is going to say.
      if (open.length >= MAX_OPEN_ITEMS) {
        openDepth = 0;
        continue;
      }
      open.push([item[2]]);
    } else if (open.length && line.trim() !== '') {
      // A wrapped line, or a sub-point: part of the thread above it, not a new
      // one. Clamping happens once, at the end, so the join cannot smuggle in
      // more than MAX_ITEM_CHARS however many lines it ran to.
      open[open.length - 1].push(line.replace(MARKER_RE, ''));
    }
  }

  return {
    title: title ?? shortText(String(name).replace(/\.md$/i, ''), MAX_TITLE_CHARS),
    date: frontmatterDate ?? date ?? null,
    open: open.map((parts) => shortText(plainText(parts.join(' ')), MAX_ITEM_CHARS)).filter(Boolean),
  };
}

/**
 * The two lines' own caps. They sum (plus the newline) to exactly
 * MAX_VAULT_DIGEST_CHARS, so the block as a whole is bounded rather than each
 * half of it being bounded separately.
 */
const HEAD_CHARS = 110;
const OPEN_CHARS = MAX_VAULT_DIGEST_CHARS - HEAD_CHARS - 1;

/**
 * The prompt block, as she would have it in her head. Two lines at most, capped
 * — it sits beside the ledger's digest and long context makes her worse:
 *
 *   Your notes for GolfCRM — "Bay codes: timezone fix" (2026-07-29).
 *   Still open there: the DST edge case; rotating the CI secret.
 *
 * Null when there is no note. A note with nothing open still yields its first
 * line: knowing when he last wrote about this project is a small true fact.
 */
export function formatVaultDigest(project, digest) {
  if (!project || !digest) return null;
  const title = digest.title ? ` — "${digest.title}"` : '';
  const when = digest.date ? ` (${digest.date})` : '';
  const lines = [shortText(`Your notes for ${project}${title}${when}.`, HEAD_CHARS)];
  if (digest.open.length) {
    lines.push(shortText(`Still open there: ${digest.open.join('; ')}.`, OPEN_CHARS));
  }
  return lines.filter(Boolean).join('\n') || null;
}

/**
 * createVault({fs, projectsDir, mapPath, cwd, now, ttlMs})
 *
 * fs          — node:fs shaped: existsSync / readdirSync / readFileSync.
 * projectsDir — the vault's `03 Projects` directory.
 * mapPath     — `projects.tsv`. Optional: without it only the loose match runs.
 * cwd         — the directory to resolve a project from, or a `() => directory`.
 *               It takes a getter because the answer moves: the interesting
 *               directory is the one his *agents* are working in, which changes
 *               through the evening, and never the one the pet was launched
 *               from (always this repo, which has no vault folder at all).
 * now         — () => ms, injected so the TTL is testable.
 * ttlMs       — how long a reading is reused.
 *
 * Returns `{enabled, digest(), stats()}`. `digest()` is lazy — nothing is read
 * until something asks — and **every** failure resolves to null: no fs, no
 * vault directory, no map, no project for this directory, an excluded project,
 * no note, an unreadable file. Null is today's behaviour, which is the whole
 * fallback story: she simply does not mention his notes.
 */
export function createVault({
  fs = null,
  projectsDir = null,
  mapPath = null,
  cwd = null,
  now = Date.now,
  ttlMs = VAULT_TTL_MS,
} = {}) {
  const clock = () => {
    const t = Number(typeof now === 'function' ? now() : now);
    return Number.isFinite(t) ? t : Date.now();
  };

  const usable = Boolean(fs)
    && Boolean(projectsDir)
    && typeof fs.readdirSync === 'function'
    && typeof fs.readFileSync === 'function';

  let cached = null; // {at, project, text}
  let reads = 0;

  const empty = (project = null) => ({ at: clock(), project, text: null });

  /** A directory, or a getter for one. A getter that throws is no directory. */
  function here() {
    try {
      const dir = typeof cwd === 'function' ? cwd() : cwd;
      return typeof dir === 'string' && dir.trim() !== '' ? dir : null;
    } catch {
      return null;
    }
  }

  function readMap() {
    if (!mapPath) return null;
    try {
      return parseProjectMap(fs.readFileSync(mapPath, 'utf8'));
    } catch {
      return null; // no map is not an error: the loose match still runs
    }
  }

  function listDir(dir) {
    try {
      const names = fs.readdirSync(dir);
      return Array.isArray(names) ? names.map((n) => String(n)) : [];
    } catch {
      return [];
    }
  }

  /** One trip to the disk. Never throws; the worst case is `{text: null}`. */
  function refresh() {
    reads += 1;
    if (typeof fs.existsSync === 'function' && !fs.existsSync(projectsDir)) return empty();

    const project = resolveProject({
      cwd: here(),
      map: readMap(),
      projectDirs: listDir(projectsDir),
    });
    if (!project) return empty();
    // Checked after resolution, not before: `Invoco-POS` becomes `Invoco` only
    // once the map has been read, and it is the vault project that is excluded.
    if (isExcluded(project)) return empty(project);

    const dir = join(projectsDir, project);
    const newest = pickNewestNote(listDir(dir));
    if (!newest) return empty(project);

    let text = '';
    try {
      text = String(fs.readFileSync(join(dir, newest.name), 'utf8') ?? '');
    } catch {
      return empty(project);
    }
    return {
      at: clock(),
      project,
      text: formatVaultDigest(project, noteDigest(text, newest)),
    };
  }

  if (!usable) {
    return {
      enabled: false,
      digest: () => null,
      stats: () => ({ enabled: false, project: null, reads: 0, cachedAt: null }),
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
    /** Introspection for tests and debugging. Carries no note text. */
    stats() {
      return {
        enabled: true,
        project: cached?.project ?? null,
        reads,
        cachedAt: cached?.at ?? null,
      };
    },
  };
}

export default createVault;
