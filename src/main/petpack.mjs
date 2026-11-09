// Pet packs — read, check and install a pet somebody handed you.
//
// A pack is a folder or a `.zip` holding either a finished ganyu pet
// (`ganyu-pet.json` plus the sheets it names) or a bare Codex pet (`pet.json` +
// `spritesheet.webp|png`, which has to be measured into a draft config). This
// module turns either into `<petsDir>/<id>/ganyu-pet.json` plus its sheets, and
// refuses — leaving the pets dir exactly as it was — everything else
// (contracts.md §Pet packs and accessories).
//
// **Why the installer is this paranoid.** A pack is the one input this app takes
// from a stranger. A zip entry named `../../Startup/x.cmd` is a classic, and a
// zip that declares 1 KB and inflates to 4 GB is another; neither is exotic.
// So the zip reader is written here, against the spec, rather than trusted to a
// dependency the repo does not have (zero runtime deps is a project rule), and
// every refusal is checked *before* anything is written.
//
// **What it does not do.** It never decodes an image and never checks a
// sheet's pixel size. The renderer is the first place a sheet is decoded, and a
// second decoder here would be one more to keep in step with it — so a pack
// with a wrong-sized sheet installs, and the renderer says so (§Drawing).
//
// No Electron import: main imports this for `defaultUserPetsDir`, and the
// installer runs under plain node. Measuring a bare Codex pet needs Electron
// (node cannot decode `.webp`), so that one step is injected as `measure` and
// `scripts/add-pet.mjs` supplies the real one. `fs` is injected throughout,
// exactly as `petconfig.mjs`, `ledger.mjs` and `vault.mjs` take it.

import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Buffer, constants as bufferConstants } from 'node:buffer';

import { isSafePetName, MAX_NAME_CHARS, loadPetConfig, resolveSheetPath, validatePetConfig } from './petconfig.mjs';

/** The file a finished pack carries, and the one an installed pet is read from. */
export const PACK_CONFIG_NAME = 'ganyu-pet.json';

/** Contract limits on a zip. A pet is a JSON file and a few sheets. */
export const ZIP_MAX_ENTRIES = 512;
export const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * A pet id becomes a directory under the pets dir, so it must be one safe path
 * segment. Dots are allowed because Codex ids can carry them, but never first —
 * which keeps `.staging-*` from ever colliding with a pet — and `..` is refused
 * anywhere. The rule itself is `isSafePetName` in `petconfig.mjs`, shared with
 * `findPetConfig`, so the installer and main cannot disagree about a name.
 */

/** Electron's `userData` for this app is `<appData>/<package name>`. */
const APP_DIR_NAME = 'ganyu-pet';
const PETS_DIR_NAME = 'pets';

/** What a bare Codex pet's sheet may be called, in the order analyze-pet looks. */
const CODEX_SHEET_NAMES = Object.freeze(['spritesheet.webp', 'spritesheet.png']);

/**
 * Archive litter that is never part of a pack. macOS Finder's "Compress" adds a
 * `__MACOSX/` tree beside the folder, which would otherwise make every zipped
 * folder look like it had two top-level entries instead of one.
 */
const JUNK_NAMES = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const codeOf = (err) => (err && (err.code || err.name)) || 'unknown error';

// ---------------------------------------------------------------------------
// Where installed pets live
// ---------------------------------------------------------------------------

/**
 * The user pets dir — `GANYU_PETS_DIR` if set, else Electron's `userData` for
 * this app plus `pets`: `%APPDATA%\ganyu-pet\pets` on Windows,
 * `~/Library/Application Support/ganyu-pet/pets` on macOS,
 * `$XDG_CONFIG_HOME/ganyu-pet/pets` (default `~/.config`) elsewhere.
 *
 * Pure: the caller passes `process.env`, `process.platform` and `os.homedir()`.
 * The path flavour follows the *injected* platform (`path.win32` / `path.posix`)
 * so a Windows answer is a Windows path even when the tests run elsewhere.
 * Returns null when there is no way to know (no override and no home) — main
 * then simply has no user dir, rather than a pets dir relative to its cwd.
 */
export function defaultUserPetsDir({ env = {}, platform, home } = {}) {
  const pick = (v) => (isNonEmptyString(v) ? v.trim() : null);
  const override = pick(env && env.GANYU_PETS_DIR);
  if (override) return override;

  const homeDir = pick(home);
  if (platform === 'win32') {
    // Electron's appData on Windows is %APPDATA%, which is <home>\AppData\Roaming
    // on every Windows that has one; the fallback only matters for a stripped env.
    const appData = pick(env && env.APPDATA) ?? (homeDir && path.win32.join(homeDir, 'AppData', 'Roaming'));
    return appData ? path.win32.join(appData, APP_DIR_NAME, PETS_DIR_NAME) : null;
  }
  if (platform === 'darwin') {
    return homeDir ? path.posix.join(homeDir, 'Library', 'Application Support', APP_DIR_NAME, PETS_DIR_NAME) : null;
  }
  const configHome = pick(env && env.XDG_CONFIG_HOME) ?? (homeDir && path.posix.join(homeDir, '.config'));
  return configHome ? path.posix.join(configHome, APP_DIR_NAME, PETS_DIR_NAME) : null;
}

/** True when `id` is safe to become `<petsDir>/<id>` — `isSafePetName`, the one rule. */
export const isSafePetId = isSafePetName;

// ---------------------------------------------------------------------------
// Names inside a pack
// ---------------------------------------------------------------------------

/**
 * Normalise a name from inside a pack — a zip entry, or a sheet path a config
 * declares — to `a/b/c` form, or say why it cannot be one.
 *
 * Backslashes become slashes **before** any check, because a zip written on
 * Windows can use either and `..\x.png` is exactly as hostile as `../x.png`.
 * Refused: empty, NUL, rooted (`/x`, which also covers `\x` and `\\server`), a
 * drive letter, any other colon (on NTFS `a:b` is a stream on file `a`), and a
 * `..` segment anywhere. `.` and empty segments are dropped. Returns
 * `{ok, name, dir}`, `dir` meaning the name ended in a slash.
 */
function normalisePackName(raw) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof raw !== 'string' || raw === '') return bad('an empty name');
  const name = raw.replace(/\\/g, '/');
  if (name.includes('\0')) return bad('a NUL byte in the name');
  if (name.startsWith('/')) return bad('an absolute path');
  if (/^[a-zA-Z]:/.test(name)) return bad('a drive letter');
  if (name.includes(':')) return bad('a colon in the name');
  const segments = name.split('/');
  if (segments.includes('..')) return bad('a ".." segment');
  const clean = segments.filter((s) => s !== '' && s !== '.');
  if (clean.length === 0 && !name.endsWith('/')) return bad('an empty name');
  return { ok: true, name: clean.join('/'), dir: name.endsWith('/') };
}

const isJunk = (name) => name.split('/').some((segment) => JUNK_NAMES.has(segment));

// ---------------------------------------------------------------------------
// Zip reading
//
// Zero-dependency, over the central directory, which is the authoritative list
// of entries: names, sizes, CRCs and methods are all taken from it, and the
// local header is used for one thing only, finding where the data starts (with
// its *own* name and extra-field lengths, which legitimately differ from the
// central ones). Stored (0) and deflate (8) only; no ZIP64, no spanning, no
// encryption. Every Buffer read is inside one try/catch, because a truncated
// archive throws a RangeError from `readUInt32LE` and that must still come back
// as a refusal rather than an exception.
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_LEN = 22;
const CENTRAL_LEN = 46;
const LOCAL_LEN = 30;
const MAX_COMMENT_LEN = 0xffff;
const ZIP64_MARK_16 = 0xffff;
const ZIP64_MARK_32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** The last end-of-central-directory record whose comment fits in the file. */
function findEocd(buf) {
  const stop = Math.max(0, buf.length - EOCD_LEN - MAX_COMMENT_LEN);
  for (let at = buf.length - EOCD_LEN; at >= stop; at--) {
    if (buf.readUInt32LE(at) === SIG_EOCD && at + EOCD_LEN + buf.readUInt16LE(at + 20) <= buf.length) {
      return at;
    }
  }
  return -1;
}

/**
 * Read a zip held in memory: `{ok, entries: [{name, data}], errors}`. **Never
 * throws.** `entries` holds files only (directory entries are skipped), with
 * names normalised to `a/b` form, and is empty whenever `ok` is false — a
 * half-read archive is not something any caller should be able to act on.
 *
 * Sizes are capped twice: the *declared* total is checked before anything is
 * inflated, and the *actual* total while inflating, with `maxOutputLength` set
 * to what is left of the budget so a lying header cannot make zlib allocate
 * past the cap in the first place.
 */
export function readZip(buffer, { maxEntries = ZIP_MAX_ENTRIES, maxTotalBytes = ZIP_MAX_TOTAL_BYTES } = {}) {
  const fail = (...errors) => ({ ok: false, entries: [], errors });
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    return fail('not a zip: expected the archive bytes');
  }
  // zlib.crc32 arrived in Node 22.2. Without it every archive would fail the
  // CRC check and be reported as damaged — blame the runtime, not the pack.
  if (typeof zlib.crc32 !== 'function') {
    return fail(`reading a zip needs Node 22.2 or newer (this is ${process.version}); unzip it and pass the folder instead`);
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  try {
    return readZipEntries(buf, { maxEntries, maxTotalBytes, fail });
  } catch (err) {
    // A read past the end of a truncated archive, mostly. The detail is not
    // actionable; what he needs to know is that the file is damaged.
    return fail(`not a readable zip — the archive is damaged or truncated (${codeOf(err)})`);
  }
}

function readZipEntries(buf, { maxEntries, maxTotalBytes, fail }) {
  if (buf.length < EOCD_LEN) return fail('not a zip: the file is too short to be one');
  const eocd = findEocd(buf);
  if (eocd < 0) return fail('not a zip: no end-of-central-directory record (truncated, or not a zip at all)');

  const disk = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (
    (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) ||
    total === ZIP64_MARK_16 ||
    centralSize === ZIP64_MARK_32 ||
    centralOffset === ZIP64_MARK_32
  ) {
    return fail('refused: a ZIP64 archive — a pet pack is small enough never to need one');
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== total) {
    return fail('refused: a split (multi-disk) archive');
  }
  if (total > maxEntries) {
    return fail(`refused: ${total} entries — a pack may hold at most ${maxEntries}`);
  }
  if (centralOffset + centralSize > eocd) {
    return fail('not a readable zip — the central directory runs past the end of the archive');
  }

  // ---- pass 1: the central directory -----------------------------------------
  const errors = [];
  const metas = [];
  const seen = new Map(); // lower-cased name -> as first seen
  let declared = 0;
  let at = centralOffset;
  for (let i = 0; i < total; i++) {
    if (at + CENTRAL_LEN > eocd || buf.readUInt32LE(at) !== SIG_CENTRAL) {
      return fail(`not a readable zip — central directory entry ${i} is damaged`);
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const externalAttrs = buf.readUInt32LE(at + 38);
    const localOffset = buf.readUInt32LE(at + 42);
    const nameEnd = at + CENTRAL_LEN + nameLen;
    if (nameEnd > eocd) return fail(`not a readable zip — central directory entry ${i} is damaged`);
    // Without the UTF-8 flag a name is CP437. latin1 is not CP437 above 0x7f,
    // but every character the checks below care about is ASCII, where the two agree.
    const rawName = buf.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1', at + CENTRAL_LEN, nameEnd);
    at = nameEnd + extraLen + commentLen;

    const quoted = JSON.stringify(rawName);
    if (size === ZIP64_MARK_32 || compressedSize === ZIP64_MARK_32 || localOffset === ZIP64_MARK_32) {
      return fail(`refused: entry ${quoted} uses ZIP64 sizes — a pet pack is small enough never to need them`);
    }
    const norm = normalisePackName(rawName);
    if (!norm.ok) {
      errors.push(`refused: entry ${quoted} has ${norm.reason} — every entry must stay inside the pack`);
      continue;
    }
    // ((attr >>> 16) & S_IFMT) — the parentheses matter: `===` binds tighter than `&`.
    if (((externalAttrs >>> 16) & S_IFMT) === S_IFLNK) {
      errors.push(`refused: entry ${quoted} is a symbolic link`);
      continue;
    }
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      errors.push(`refused: entry ${quoted} is encrypted`);
      continue;
    }
    if (norm.dir) continue; // directories carry nothing; their files say where they live
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      errors.push(`refused: entry ${quoted} uses compression method ${method} — only stored (0) and deflate (8) are read`);
      continue;
    }
    // Case-insensitive, because Windows and macOS would write both to one file
    // and whichever came second would silently win.
    const key = norm.name.toLowerCase();
    if (seen.has(key)) {
      errors.push(`refused: entry ${quoted} appears twice (also as ${JSON.stringify(seen.get(key))})`);
      continue;
    }
    seen.set(key, rawName);

    declared += size;
    if (declared > maxTotalBytes) {
      return fail(
        `refused: the archive declares more than ${maxTotalBytes.toLocaleString('en-US')} bytes uncompressed — the most a pack may hold`,
      );
    }
    metas.push({ name: norm.name, quoted, method, crc, compressedSize, size, localOffset });
  }
  if (errors.length) return fail(...errors);

  // ---- pass 2: the data --------------------------------------------------------
  const entries = [];
  let actual = 0;
  for (const m of metas) {
    const local = m.localOffset;
    if (local + LOCAL_LEN > buf.length || buf.readUInt32LE(local) !== SIG_LOCAL) {
      return fail(`not a readable zip — the local header of ${m.quoted} is damaged`);
    }
    const start = local + LOCAL_LEN + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const end = start + m.compressedSize;
    if (end > buf.length) return fail(`not a readable zip — ${m.quoted} is truncated`);
    const packed = buf.subarray(start, end);

    let data;
    if (m.method === METHOD_STORED) {
      if (m.compressedSize !== m.size) {
        return fail(`not a readable zip — ${m.quoted} is stored but its two sizes disagree`);
      }
      data = Buffer.from(packed); // a copy, so no entry pins the whole archive in memory
    } else {
      const budget = Math.min(Math.max(1, maxTotalBytes - actual), bufferConstants.MAX_LENGTH);
      try {
        data = zlib.inflateRawSync(packed, { maxOutputLength: budget });
      } catch (err) {
        if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
          return fail(
            `refused: ${m.quoted} inflates past ${maxTotalBytes.toLocaleString('en-US')} bytes, the most a pack may hold — its header understates its size`,
          );
        }
        return fail(`not a readable zip — ${m.quoted} does not inflate (${codeOf(err)})`);
      }
    }
    actual += data.length;
    if (actual > maxTotalBytes) {
      return fail(
        `refused: the archive inflates past ${maxTotalBytes.toLocaleString('en-US')} bytes, the most a pack may hold — its headers understate its size`,
      );
    }
    if (data.length !== m.size) {
      return fail(`not a readable zip — ${m.quoted} is ${data.length} bytes, but its header says ${m.size}`);
    }
    if (zlib.crc32(data) >>> 0 !== m.crc) {
      return fail(`not a readable zip — ${m.quoted} fails its CRC check (the archive is damaged)`);
    }
    entries.push({ name: m.name, data });
  }
  return { ok: true, entries, errors: [] };
}

// ---------------------------------------------------------------------------
// Reading a pack
//
// A folder and a zip are both reduced to one small view, `lookup(rel)` ->
// `{found, data}`, so the rules about what a pack must contain are written once.
// ---------------------------------------------------------------------------

/** A zip's pack root: the archive root, or its single top-level folder. */
function zipView(entries) {
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const names = [...files.keys()].filter((n) => !isJunk(n));
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const wrapped = tops.size === 1 && names.every((n) => n.includes('/'));
  const prefix = wrapped ? `${[...tops][0]}/` : '';
  return {
    rootName: wrapped ? [...tops][0] : null,
    lookup(rel) {
      return files.has(prefix + rel)
        ? { found: true, data: files.get(prefix + rel) }
        : { found: false, reason: 'is not in the pack' };
    },
  };
}

/**
 * A folder's pack root, by the same rule. A file the config names is found by
 * path, then its real path is checked to still be inside the root — a symlink or
 * junction in a folder pack is the folder-shaped version of a zip-slip entry.
 */
function folderView(fs, source) {
  const listing = fs.readdirSync(source, { withFileTypes: true }).filter((d) => !JUNK_NAMES.has(d.name));
  const root = listing.length === 1 && listing[0].isDirectory() ? path.join(source, listing[0].name) : source;
  const realRoot = fs.realpathSync(root);
  return {
    root,
    lookup(rel) {
      const full = path.join(root, ...rel.split('/'));
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return { found: false, reason: 'is not in the pack' };
      }
      if (!stat.isFile()) return { found: false, reason: 'is not a file' };
      const back = path.relative(realRoot, fs.realpathSync(full));
      if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
        return { found: false, reason: 'is a link to somewhere outside the pack' };
      }
      return { found: true, data: fs.readFileSync(full), path: full };
    },
  };
}

/** Every sheet a config names, read defensively: `accessories` may not exist yet. */
function sheetRefs(config) {
  const refs = [{ where: 'spritesheet', value: config.spritesheet, set: (c, v) => (c.spritesheet = v) }];
  if (Array.isArray(config.accessories)) {
    config.accessories.forEach((entry, i) => {
      if (isPlainObject(entry) && typeof entry.sheet === 'string') {
        refs.push({ where: `accessories[${i}].sheet`, value: entry.sheet, set: (c, v) => (c.accessories[i].sheet = v) });
      }
    });
  }
  return refs;
}

/**
 * Case 1: a finished pack. Parsed and validated by `loadPetConfig` itself — the
 * app's own loader, handed the bytes through a one-method `fs` — so the
 * messages are exactly the ones the app would print, `ganyu-pet.json: ` and all,
 * and there is no second loader to drift from the first.
 */
function readFinishedPack(view, data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const loaded = loadPetConfig({ fs: { readFileSync: () => text }, filePath: PACK_CONFIG_NAME });
  if (!loaded.ok) return { ok: false, errors: loaded.errors };

  const config = JSON.parse(JSON.stringify(loaded.config));
  const files = new Map(); // installed relative path -> bytes
  const errors = [];
  for (const ref of sheetRefs(loaded.config)) {
    const label = `${PACK_CONFIG_NAME}: ${ref.where} ${JSON.stringify(ref.value)}`;
    if (path.isAbsolute(ref.value) || path.win32.isAbsolute(ref.value)) {
      errors.push(`${label} is absolute — a pack's sheets must be relative paths inside the pack`);
      continue;
    }
    const norm = normalisePackName(ref.value);
    if (!norm.ok || norm.dir) {
      errors.push(`${label} has ${norm.ok ? 'a trailing slash' : norm.reason} — a pack's sheets must be relative paths inside the pack`);
      continue;
    }
    const hit = view.lookup(norm.name);
    if (!hit.found) {
      errors.push(`${label} ${hit.reason}`);
      continue;
    }
    files.set(norm.name, hit.data);
    ref.set(config, norm.name);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, config, files, drafted: false, placeholders: [] };
}

/**
 * Case 2: a bare Codex pet. `measure({dir, sheetPath})` must return
 * `{ok, config, placeholders, errors}` — the `{ok, errors}` shape everything
 * else here uses, because the real one shells out to Electron and has real ways
 * to fail. A zip has no directory to measure, so its two files are extracted to
 * a temp dir named after the pack (the draft's fallback id is that name) and the
 * dir is removed again whatever happens.
 */
function readCodexPet({ fs, view, sheetName, sheetData, metaData, measure, tmpdir, packName }) {
  if (typeof measure !== 'function') {
    return {
      ok: false,
      errors: [
        'this is a bare Codex pet (pet.json + spritesheet), whose config has to be drafted by measuring the sheet — and no measure step was given',
      ],
    };
  }

  let scratch = null;
  let dir = view.root;
  let result;
  try {
    if (!dir) {
      scratch = fs.mkdtempSync(path.join(tmpdir, 'ganyu-pack-'));
      dir = path.join(scratch, isSafePetId(packName) ? packName : 'pet');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pet.json'), metaData);
      fs.writeFileSync(path.join(dir, sheetName), sheetData);
    }
    result = measure({ dir, sheetPath: path.join(dir, sheetName) });
  } catch (err) {
    result = { ok: false, errors: [`measuring the sheet failed (${(err && err.message) || codeOf(err)})`] };
  } finally {
    if (scratch) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // A temp dir we made and could not remove is litter in the temp dir,
        // not a reason to refuse the pet.
      }
    }
  }

  if (!result || result.ok !== true || !isPlainObject(result.config)) {
    const errors = result && Array.isArray(result.errors) && result.errors.length ? result.errors : ['measuring the sheet produced no draft'];
    return { ok: false, errors };
  }
  const config = { ...JSON.parse(JSON.stringify(result.config)), spritesheet: sheetName };
  const check = validatePetConfig(config);
  if (!check.ok) return { ok: false, errors: check.errors.map((msg) => `drafted config: ${msg}`) };
  return {
    ok: true,
    config,
    files: new Map([[sheetName, sheetData]]),
    drafted: true,
    placeholders: Array.isArray(result.placeholders) ? result.placeholders : [],
  };
}

/**
 * Read and check a pack without writing anything to the pets dir:
 * `{ok, config, files, drafted, placeholders, errors}`, where `files` maps each
 * installed relative path (forward slashes) to its bytes and `config` already
 * has its sheet paths rewritten to those. **Never throws.**
 *
 * `source` is a folder or a `.zip` path. `zipLimits` passes through to
 * `readZip` (the tests shrink the caps); `tmpdir` is where a zipped Codex pet is
 * extracted for measuring.
 */
export function readPack({ fs, source, measure, tmpdir = os.tmpdir(), zipLimits } = {}) {
  const shaped = (fields) => ({ ok: false, config: null, files: new Map(), drafted: false, placeholders: [], errors: [], ...fields });
  const fail = (...errors) => shaped({ errors });
  if (!fs) return fail('readPack: an fs must be injected');
  if (!isNonEmptyString(source)) return fail('readPack: expected a pack path');

  try {
    let stat;
    try {
      stat = fs.statSync(source);
    } catch (err) {
      return fail(`${source}: cannot be read (${codeOf(err)})`);
    }

    let view;
    let packName;
    if (stat.isDirectory()) {
      view = folderView(fs, source);
      packName = path.basename(view.root);
    } else if (stat.isFile() && path.extname(source).toLowerCase() === '.zip') {
      // The zip is read whole, so refuse one that could not possibly be a
      // pack before reading it: compressed data never needs to be much bigger
      // than the uncompressed cap.
      const cap = (zipLimits && zipLimits.maxTotalBytes) || ZIP_MAX_TOTAL_BYTES;
      if (stat.size > cap * 2) {
        return fail(`${source}: refused — the file is ${stat.size.toLocaleString('en-US')} bytes, far more than a pack may hold`);
      }
      const zip = readZip(fs.readFileSync(source), zipLimits);
      if (!zip.ok) return fail(...zip.errors.map((msg) => `${source}: ${msg}`));
      view = zipView(zip.entries);
      packName = view.rootName || path.basename(source, path.extname(source));
    } else {
      return fail(`${source}: not a pack — expected a folder or a .zip file`);
    }

    const finished = view.lookup(PACK_CONFIG_NAME);
    if (finished.found) return shaped(readFinishedPack(view, finished.data));

    const meta = view.lookup('pet.json');
    const sheet = meta.found
      ? CODEX_SHEET_NAMES.map((name) => ({ name, hit: view.lookup(name) })).find((s) => s.hit.found)
      : null;
    if (sheet) {
      return shaped(
        readCodexPet({
          fs,
          view,
          sheetName: sheet.name,
          sheetData: sheet.hit.data,
          metaData: meta.data,
          measure,
          tmpdir,
          packName,
        }),
      );
    }
    if (meta.found) {
      return fail(`${source}: has a pet.json but no ${CODEX_SHEET_NAMES.join(' or ')} beside it`);
    }
    return fail(
      `${source}: not a pet pack — it needs ${PACK_CONFIG_NAME} (a finished pet) or pet.json + ${CODEX_SHEET_NAMES.join('|')} (a bare Codex pet), at its root or in its single top-level folder`,
    );
  } catch (err) {
    return fail(`${source}: cannot be read (${codeOf(err)})`);
  }
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/**
 * `renameSync`, retried briefly on the three codes Windows returns while
 * something (an antivirus scan of the files just written, usually) holds a
 * handle on the directory. A fresh install failing at random would be blamed on
 * the pack.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 10;
const RENAME_WAIT_MS = 50;

function renameWithRetry(fs, from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has(err && err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
    }
  }
}

function exists(fs, p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install a pack: `{ok, id, dir, drafted, placeholders, backup, errors}`.
 * **Never throws**, and on any failure the pets dir is left as it was.
 *
 * Order matters. Everything that can be refused without writing — reading,
 * validating, the id, an existing install without `force` — is refused first.
 * Only then is the pets dir created and a `.staging-*` dir made *inside it* (the
 * same volume, so the final rename is a rename and never a copy). The staged
 * config is re-read through `loadPetConfig`, the same loader the app uses,
 * before anything is moved. With `force`, the old copy is renamed to
 * `<id>.bak-<now()>` and, should the final rename then fail, renamed back.
 */
export function installPack({
  fs,
  source,
  petsDir,
  force = false,
  measure,
  now = Date.now,
  log = () => {},
  tmpdir = os.tmpdir(),
  zipLimits,
} = {}) {
  const done = (fields) => ({
    ok: false,
    id: null,
    dir: null,
    drafted: false,
    placeholders: [],
    backup: null,
    errors: [],
    ...fields,
  });
  if (!fs) return done({ errors: ['installPack: an fs must be injected'] });
  if (!isNonEmptyString(petsDir)) return done({ errors: ['installPack: expected a pets directory'] });

  let staging = null;
  try {
    const pack = readPack({ fs, source, measure, tmpdir, zipLimits });
    if (!pack.ok) return done({ errors: pack.errors });
    const { config, drafted, placeholders } = pack;
    const base = { drafted, placeholders };

    const id = config.id;
    if (!isSafePetId(id)) {
      return done({
        ...base,
        errors: [
          `id: ${JSON.stringify(id)} cannot be installed — it becomes the directory <pets dir>/<id>, so it must be lowercase letters, digits, ".", "-" and "_", starting with a letter or digit, with no "..", at most ${MAX_NAME_CHARS} characters`,
        ],
      });
    }
    const dir = path.join(petsDir, id);
    if (exists(fs, dir) && !force) {
      return done({
        ...base,
        id,
        errors: [`"${id}" is already installed at ${dir} — pass --force to replace it (the old copy is kept as ${id}.bak-<timestamp>)`],
      });
    }

    fs.mkdirSync(petsDir, { recursive: true });
    staging = fs.mkdtempSync(path.join(petsDir, '.staging-'));
    for (const [rel, data] of pack.files) {
      const target = path.join(staging, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    const stagedConfig = path.join(staging, PACK_CONFIG_NAME);
    fs.writeFileSync(stagedConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const staged = loadPetConfig({ fs, filePath: stagedConfig });
    if (!staged.ok) return done({ ...base, id, errors: staged.errors });
    const stagedSheet = resolveSheetPath(staged.config, stagedConfig);
    if (!stagedSheet || !exists(fs, stagedSheet)) {
      return done({ ...base, id, errors: [`the staged copy has no spritesheet at ${stagedSheet}`] });
    }

    let backup = null;
    if (exists(fs, dir)) {
      // Checked again, because the first check was before staging: something
      // that appeared since is still not ours to move without `force`.
      if (!force) {
        return done({ ...base, id, errors: [`"${id}" appeared at ${dir} while installing — pass --force to replace it`] });
      }
      backup = path.join(petsDir, `${id}.bak-${now()}`);
      for (let n = 2; exists(fs, backup); n++) backup = path.join(petsDir, `${id}.bak-${now()}-${n}`);
      renameWithRetry(fs, dir, backup);
    }
    try {
      renameWithRetry(fs, staging, dir);
    } catch (err) {
      if (backup) {
        try {
          renameWithRetry(fs, backup, dir);
        } catch (restoreErr) {
          return done({
            ...base,
            id,
            errors: [
              `could not move the new copy into place (${codeOf(err)}), and could not put the old one back (${codeOf(restoreErr)}) — it is at ${backup}`,
            ],
          });
        }
      }
      throw err;
    }
    staging = null;
    return { ok: true, id, dir, drafted, placeholders, backup, errors: [] };
  } catch (err) {
    return done({ errors: [`install failed (${codeOf(err)}${err && err.path ? ` at ${err.path}` : ''})`] });
  } finally {
    if (staging) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch (err) {
        log(`could not remove the staging dir ${staging} (${codeOf(err)}) — it is safe to delete`);
      }
    }
  }
}
