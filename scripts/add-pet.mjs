// Install a pet pack into the user pets dir.
//
//   npm run add-pet -- <pack.zip | pack-folder | codex-pet-id> [options]
//   node scripts/add-pet.mjs <pack.zip | pack-folder | codex-pet-id> [options]
//
//   --pets-dir D    install here instead of the user pets dir (one run only)
//   --force         replace an installed pet of the same id (kept as <id>.bak-<ts>)
//   --codex-home D  where Codex pets live (default $CODEX_HOME, else ~/.codex)
//
// The work is `installPack` in `src/main/petpack.mjs`; this file is the shell
// around it — arguments, finding the source, the one step that needs Electron,
// and saying plainly what happened (contracts.md §Pet packs and accessories).
//
// **The Electron step.** A bare Codex pet has no config, only a sheet, and the
// sheet is usually `.webp`, which node cannot decode. So its config is drafted
// by `scripts/analyze-pet.mjs` running under Electron, exactly as a person
// would run it by hand, with `--out` pointed at a temp file this script reads
// back. Everything else here is plain node, so installing a finished pack never
// starts Electron at all.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defaultUserPetsDir, installPack, isSafePetId } from '../src/main/petpack.mjs';
import { DRAFT_PLACEHOLDERS } from './analyze-pet.mjs';

const SCRIPT = 'add-pet.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANALYZER = path.join(HERE, 'analyze-pet.mjs');

/** Long enough for a cold Electron start on a slow disk; a hung one still ends. */
const MEASURE_TIMEOUT_MS = 60_000;

/** How much of a failed analyzer's stderr is worth showing. */
const STDERR_TAIL_LINES = 12;

export const USAGE = [
  `usage: npm run add-pet -- <pack.zip | pack-folder | codex-pet-id> [--pets-dir D] [--force] [--codex-home D]`,
  '',
  '  pack.zip / pack-folder  a ganyu pet (ganyu-pet.json + its sheets), or a bare Codex pet',
  '                          (pet.json + spritesheet.webp|png), at the root or in one top-level folder',
  '  codex-pet-id            a Codex pet installed under $CODEX_HOME/pets/<id> (default ~/.codex/pets/<id>)',
  '  --pets-dir D            install into D instead of the user pets dir',
  '  --force                 replace an installed pet with the same id; the old copy is kept as <id>.bak-<timestamp>',
  '  --codex-home D          look for Codex pet ids under D/pets',
].join('\n');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * `argv` is the arguments after the script (`process.argv.slice(2)`):
 * `{ok, target, petsDir, force, codexHome, help, errors}`. Never throws.
 */
export function parseArgs(argv) {
  const out = { ok: true, target: null, petsDir: null, force: false, codexHome: null, help: false, errors: [] };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (name) => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.errors.push(`${name} needs a value`);
        return null;
      }
      i += 1;
      return next;
    };
    if (arg === '--pets-dir') out.petsDir = value('--pets-dir');
    else if (arg === '--codex-home') out.codexHome = value('--codex-home');
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) out.errors.push(`unknown option ${arg}`);
    else if (out.target === null) out.target = arg;
    else out.errors.push(`unexpected extra argument ${arg}`);
  }
  if (!out.help && out.target === null) out.errors.push('no pack given');
  out.ok = out.errors.length === 0;
  return out;
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * An argument that exists on disk is a pack. One that does not is a Codex pet
 * id, looked up as `<codexHome>/pets/<id>` — and checked as a safe name first,
 * because it is about to become a path segment.
 */
function resolveSource({ fs: fsImpl, target, codexHome, baseDir }) {
  try {
    const onDisk = path.resolve(baseDir, target);
    fsImpl.statSync(onDisk);
    return { ok: true, source: onDisk };
  } catch {
    // Not on disk: fall through to reading it as a Codex pet id.
  }
  if (!isSafePetId(target)) {
    return {
      ok: false,
      errors: [
        `"${target}" is not a file or folder, and not a Codex pet id either — an id is lowercase letters, digits, ".", "-" and "_", starting with a letter or digit`,
      ],
    };
  }
  if (!codexHome) {
    return { ok: false, errors: [`"${target}" is not a file or folder; to read it as a Codex pet id, pass --codex-home`] };
  }
  const dir = path.join(codexHome, 'pets', target);
  let isDir = false;
  try {
    isDir = fsImpl.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { ok: false, errors: [`"${target}" is not a file or folder, and there is no Codex pet with that id at ${dir}`] };
  }
  return { ok: true, source: dir };
}

// ---------------------------------------------------------------------------
// Measuring a bare Codex pet (the Electron step)
// ---------------------------------------------------------------------------

/**
 * The electron binary, the way `scripts/smoke.mjs` finds it: the `electron`
 * package's main is the path to the binary. `{ok, path, errors}`.
 */
function resolveElectron() {
  try {
    const resolved = createRequire(import.meta.url)('electron');
    if (typeof resolved === 'string' && resolved) return { ok: true, path: resolved };
    return { ok: false, errors: ['the electron package did not resolve to a binary path — run `npm install`'] };
  } catch (err) {
    return { ok: false, errors: [`cannot find electron (${(err && (err.code || err.message)) || 'unknown error'}) — run \`npm install\``] };
  }
}

/**
 * The real `measure` for `installPack`: run analyze-pet under Electron on the
 * pack's sheet and read the draft back from a temp file. Returns
 * `{ok, config, placeholders, errors}`.
 *
 * The analyzer is handed the **sheet path**, not the directory. Given a
 * directory it would follow `pet.json`'s `spritesheetPath`, which in a pack from
 * a stranger can name any file on disk — and the installer copies
 * `spritesheet.webp|png` from the pack, so the two could measure one image and
 * install another. Given the sheet, it measures exactly the file that is
 * installed, and still reads `pet.json` beside it for the id and display name.
 */
export function createElectronMeasure({
  fs: fsImpl = fs,
  env = process.env,
  codexHome,
  tmpdir = os.tmpdir(),
  electron = resolveElectron,
  spawn = spawnSync,
} = {}) {
  return function measure({ sheetPath }) {
    const bin = electron();
    if (!bin.ok) return { ok: false, errors: bin.errors };

    let scratch;
    try {
      scratch = fsImpl.mkdtempSync(path.join(tmpdir, 'ganyu-add-pet-'));
    } catch (err) {
      return { ok: false, errors: [`cannot make a temp dir for the draft (${(err && err.code) || 'unknown error'})`] };
    }
    const outFile = path.join(scratch, 'draft.json');
    try {
      const child = spawn(bin.path, [ANALYZER, sheetPath, '--out', outFile], {
        env: { ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
        encoding: 'utf8',
        timeout: MEASURE_TIMEOUT_MS,
        windowsHide: true,
      });
      if (child.error) {
        return { ok: false, errors: [`could not run the analyzer under electron (${child.error.code || child.error.message})`] };
      }
      if (child.status !== 0) {
        const tail = String(child.stderr || '').trim().split(/\r?\n/).slice(-STDERR_TAIL_LINES);
        return {
          ok: false,
          errors: [`the analyzer could not measure ${sheetPath} (exit ${child.status ?? child.signal})`, ...tail.filter(Boolean)],
        };
      }
      let config;
      try {
        config = JSON.parse(fsImpl.readFileSync(outFile, 'utf8'));
      } catch (err) {
        return { ok: false, errors: [`the analyzer ran but its draft could not be read (${(err && (err.code || err.message)) || 'unknown error'})`] };
      }
      return { ok: true, config, placeholders: DRAFT_PLACEHOLDERS, errors: [] };
    } finally {
      try {
        fsImpl.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // A temp file left in the temp dir is not worth failing an install over.
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printDraftNotice({ print, dir, placeholders }) {
  const width = Math.max(...placeholders.map((p) => p.field.length));
  print('');
  print('--- DRAFTED — the geometry is measured, the semantics are NOT ---------------');
  print('  This was a bare Codex pet, so its config was drafted by scripts/analyze-pet.mjs.');
  print('  Measured off the image: the grid, the frame size and every row\'s frame count.');
  print('  Placeholders — nothing in the file or the pixels says what these should be:');
  for (const p of placeholders) print(`    ${p.field.padEnd(width)}  ${p.note}`);
  print('  It runs as it is, but every mode points at row 0, so it will stand still');
  print('  through everything. Look at the sheet and fix the placeholders in');
  print(`    ${path.join(dir, 'ganyu-pet.json')}`);
  print('  following docs/pet-config.md, steps 2-4.');
  print('-----------------------------------------------------------------------------');
}

/**
 * The CLI, with every outside thing injected so the tests drive it without
 * spawning: `deps` = `{fs, env, platform, home, measure, now, print, printError}`.
 * Returns the exit code. `measure` defaults to the real Electron one.
 */
export function main(argv, deps = {}) {
  const {
    fs: fsImpl = fs,
    env = {},
    platform = process.platform,
    home = null,
    measure,
    now,
    print = (line) => console.log(line),
    printError = (line) => console.error(line),
  } = deps;

  const args = parseArgs(argv);
  if (args.help) {
    print(USAGE);
    return 0;
  }
  if (!args.ok) {
    for (const e of args.errors) printError(`${SCRIPT}: ${e}`);
    printError(USAGE);
    return 1;
  }

  // `npm run` starts this script in the package root, not where the user typed
  // the command; npm records that directory as INIT_CWD. Relative paths the
  // user typed are resolved against it, so `npm run add-pet -- my-pet.zip`
  // means the zip beside them, wherever they are.
  const baseDir = typeof env.INIT_CWD === 'string' && env.INIT_CWD.trim() ? env.INIT_CWD.trim() : process.cwd();
  const fromUser = (p) => (p == null ? p : path.resolve(baseDir, p));

  const petsDir = fromUser(args.petsDir) ?? defaultUserPetsDir({ env, platform, home });
  if (!petsDir) {
    printError(`${SCRIPT}: cannot work out the user pets dir on this machine — pass --pets-dir`);
    return 1;
  }
  const envCodexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : null;
  const codexHome = fromUser(args.codexHome) ?? envCodexHome ?? (home ? path.join(home, '.codex') : null);

  const found = resolveSource({ fs: fsImpl, target: args.target, codexHome, baseDir });
  if (!found.ok) {
    for (const e of found.errors) printError(`${SCRIPT}: ${e}`);
    return 1;
  }

  const result = installPack({
    fs: fsImpl,
    source: found.source,
    petsDir,
    force: args.force,
    measure: measure ?? createElectronMeasure({ fs: fsImpl, env, codexHome }),
    ...(now ? { now } : {}),
    log: (line) => printError(`${SCRIPT}: ${line}`),
  });

  if (!result.ok) {
    printError(`${SCRIPT}: did not install ${found.source}:`);
    for (const e of result.errors) printError(`  ${e}`);
    printError(`  Nothing was changed in ${petsDir}.`);
    return 1;
  }

  print(`installed "${result.id}" to ${result.dir}`);
  if (result.backup) print(`  the copy it replaced is kept at ${result.backup}`);
  print('');
  print('To run it:');
  print(`  npm start -- --pet ${result.id}      this run only`);
  print(`  GANYU_PET=${result.id}               every run on this machine`);
  if (result.drafted) {
    printDraftNotice({
      print,
      dir: result.dir,
      placeholders: result.placeholders.length ? result.placeholders : DRAFT_PLACEHOLDERS,
    });
  }
  return 0;
}

/** True only when this file is the script being run (see analyze-pet.mjs). */
function isEntryScript() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const a = path.resolve(entry);
  const b = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isEntryScript()) {
  process.exitCode = main(process.argv.slice(2), {
    fs,
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
  });
}
