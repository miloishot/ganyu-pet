// Pet pack tests — installing a pet somebody handed you.
//
// Every directory here is made under `os.tmpdir()` by the test that uses it and
// removed by that test; the real user pets dir and `~/.codex` are never read,
// written or listed — every path is injected. Zips are written by a tiny
// writer *in this file* (stored + deflate over `zlib.deflateRawSync`), which is
// scaffolding for building hostile archives on purpose, not a second decoder.
// Sheet bytes are the repo's own `assets/starter-pet.png`; the config is a copy
// of `pets/starter.json` pointed at it.
//
// Themes:
//   1. the happy paths — a folder, a zip, a zip with `\` separators, a zip and
//      a folder wrapped in one top-level folder, a Codex pet by id, a zipped
//      Codex pet — each read back through `loadPetConfig`, the app's loader;
//   2. refusals — every one asserts the message *and* that the pets dir
//      listing is byte-for-byte what it was before;
//   3. replacing — refused without force, backed up with it, rolled back when
//      the final rename fails;
//   4. `defaultUserPetsDir` on every platform, all injected;
//   5. one real Electron run of analyze-pet (skipped when there is no binary);
//   6. analyze-pet imports under plain node without starting anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as petconfig from '../src/main/petconfig.mjs';
import {
  PACK_CONFIG_NAME,
  ZIP_MAX_ENTRIES,
  defaultUserPetsDir,
  installPack,
  isSafePetId,
  readPack,
  readZip,
} from '../src/main/petpack.mjs';
import { DRAFT_PLACEHOLDERS, draftConfig, framesInRow, inferCount } from '../scripts/analyze-pet.mjs';
import { createElectronMeasure, main, parseArgs } from '../scripts/add-pet.mjs';

const { loadPetConfig, resolveSheetPath, validatePetConfig } = petconfig;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEET = fs.readFileSync(path.join(ROOT, 'assets', 'starter-pet.png'));
const STARTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'pets', 'starter.json'), 'utf8'));
const ANALYZER = path.join(ROOT, 'scripts', 'analyze-pet.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh temp dir, removed when the test ends. Only ever under os.tmpdir(). */
function tmp(t, label = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ganyu-petpack-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The starter config, pointed at a sheet beside it, minus anything optional that needs more files. */
function fixtureConfig(overrides = {}) {
  const config = JSON.parse(JSON.stringify(STARTER));
  delete config.accessories;
  config.spritesheet = 'sheet.png';
  return { ...config, ...overrides };
}

const packFiles = (config = fixtureConfig()) => ({
  [PACK_CONFIG_NAME]: Buffer.from(JSON.stringify(config, null, 2)),
  'sheet.png': SHEET,
});

function writeFolder(dir, files) {
  for (const [name, data] of Object.entries(files)) {
    const full = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
  return dir;
}

/** Every path under `dir`, sorted, or null when it does not exist. */
function listing(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

/**
 * The zip writer. Each entry: `{name, data, method = 8, flags, externalAttrs,
 * madeBy, crc, size, packed, localExtra, centralExtra}` — every field that a
 * hostile archive lies about can be overridden.
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const method = e.method ?? 8;
    const packed = e.packed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const name = Buffer.from(e.name, 'utf8');
    const crc = (e.crc ?? zlib.crc32(data)) >>> 0;
    const size = e.size ?? data.length;
    const flags = (e.flags ?? 0) | 0x0800;
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    const centralExtra = e.centralExtra ?? Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const record = Buffer.concat([local, name, localExtra, packed]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE((e.externalAttrs ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(record);
    centrals.push(Buffer.concat([central, name, centralExtra]));
    offset += record.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const zipOf = (files, { prefix = '', sep = '/' } = {}) =>
  makeZip(Object.entries(files).map(([name, data]) => ({ name: (prefix + name).split('/').join(sep), data })));

function writeZip(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** Install, then read the result back through the app's own loader. */
function assertInstalled(result, { id = STARTER.id } = {}) {
  assert.equal(result.ok, true, `expected an install, got:\n${result.errors.join('\n')}`);
  assert.equal(result.id, id);
  const filePath = path.join(result.dir, PACK_CONFIG_NAME);
  const loaded = loadPetConfig({ fs, filePath });
  assert.equal(loaded.ok, true, loaded.errors.join('\n'));
  const sheet = resolveSheetPath(loaded.config, filePath);
  assert.ok(sheet && fs.statSync(sheet).isFile(), `the installed sheet should exist at ${sheet}`);
  assert.ok(!path.isAbsolute(loaded.config.spritesheet), 'the installed config points at its sheet relatively');
  return loaded.config;
}

/** A pets dir that already holds something, so "unchanged" is not trivially an empty list. */
function populatedPetsDir(t) {
  const petsDir = path.join(tmp(t, 'pets'), 'pets');
  writeFolder(path.join(petsDir, 'other'), { [PACK_CONFIG_NAME]: '{}', 'sheet.png': SHEET });
  return petsDir;
}

function assertRefused(t, { source, needle, petsDir = populatedPetsDir(t), ...opts }) {
  const before = listing(petsDir);
  const result = installPack({ fs, source, petsDir, measure: noMeasure, ...opts });
  assert.equal(result.ok, false, 'expected the pack to be refused');
  const text = result.errors.join('\n');
  for (const n of [].concat(needle)) {
    assert.ok(text.includes(n), `expected an error mentioning ${JSON.stringify(n)}, got:\n${text}`);
  }
  assert.deepEqual(listing(petsDir), before, 'a refusal must leave the pets dir exactly as it was');
  return result;
}

function noMeasure() {
  throw new Error('measure should not be called for this pack');
}

/** A stub measure: the draft analyze-pet would produce for the starter sheet. */
function stubMeasure(calls = []) {
  return ({ dir, sheetPath }) => {
    calls.push({ dir, sheetPath, files: fs.readdirSync(dir).sort() });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'));
    return {
      ok: true,
      config: draftConfig({
        id: meta.id,
        displayName: meta.displayName,
        spritesheet: sheetPath,
        cols: 4,
        rows: 4,
        cellW: 64,
        cellH: 64,
        frames: [3, 4, 4, 2],
      }),
      placeholders: DRAFT_PLACEHOLDERS,
      errors: [],
    };
  };
}

const CODEX_META = { id: 'fixture-pet', displayName: 'Fixture', description: 'generated', spritesheetPath: 'spritesheet.png', kind: 'pet' };

function codexFiles(meta = CODEX_META) {
  return { 'pet.json': JSON.stringify(meta), 'spritesheet.png': SHEET };
}

function codexHomeWith(t, id = CODEX_META.id) {
  const home = tmp(t, 'codex');
  writeFolder(path.join(home, 'pets', id), codexFiles({ ...CODEX_META, id }));
  return home;
}

// ---------------------------------------------------------------------------
// 1. Installing
// ---------------------------------------------------------------------------

test('a folder pack installs and reads back through the app loader', (t) => {
  const source = writeFolder(tmp(t, 'src'), packFiles());
  const petsDir = path.join(tmp(t, 'pets'), 'pets');
  const result = installPack({ fs, source, petsDir, measure: noMeasure });
  assertInstalled(result);
  assert.equal(result.drafted, false);
  assert.equal(result.backup, null);
  assert.deepEqual(listing(petsDir).filter((n) => !n.includes(path.sep)), ['starter'], 'no staging dir is left behind');
});

test('a zip pack installs', (t) => {
  const dir = tmp(t, 'src');
  const source = writeZip(dir, 'pip.zip', zipOf(packFiles()));
  assertInstalled(installPack({ fs, source, petsDir: path.join(dir, 'pets'), measure: noMeasure }));
});

test('a zip written with backslash separators installs', (t) => {
  const dir = tmp(t, 'src');
  const config = fixtureConfig({ spritesheet: 'art\\sheet.png' });
  const files = { [PACK_CONFIG_NAME]: Buffer.from(JSON.stringify(config)), 'art/sheet.png': SHEET };
  const source = writeZip(dir, 'pip.zip', zipOf(files, { prefix: 'pip/', sep: '\\' }));
  const installed = assertInstalled(installPack({ fs, source, petsDir: path.join(dir, 'pets'), measure: noMeasure }));
  assert.equal(installed.spritesheet, 'art/sheet.png', 'the sheet path is rewritten with forward slashes');
});

test('a zip wrapped in a single top-level folder installs (and macOS litter is ignored)', (t) => {
  const dir = tmp(t, 'src');
  const entries = Object.entries(packFiles()).map(([name, data]) => ({ name: `pip-pack/${name}`, data }));
  entries.unshift({ name: 'pip-pack/', data: '' }); // a directory entry, skipped
  entries.push({ name: '__MACOSX/pip-pack/._sheet.png', data: 'resource fork' });
  const source = writeZip(dir, 'pip.zip', makeZip(entries));
  assertInstalled(installPack({ fs, source, petsDir: path.join(dir, 'pets'), measure: noMeasure }));
});

test('a folder wrapped in a single top-level folder installs', (t) => {
  const dir = tmp(t, 'src');
  writeFolder(path.join(dir, 'outer', 'pip'), packFiles());
  assertInstalled(installPack({ fs, source: path.join(dir, 'outer'), petsDir: path.join(dir, 'pets'), measure: noMeasure }));
});

test('a Codex pet by id installs as a draft, and the CLI says which fields are placeholders', (t) => {
  const codexHome = codexHomeWith(t);
  const petsDir = path.join(tmp(t, 'pets'), 'pets');
  const calls = [];
  const out = [];
  const err = [];
  const code = main(['fixture-pet', '--pets-dir', petsDir, '--codex-home', codexHome], {
    fs,
    env: {},
    platform: process.platform,
    home: null,
    measure: stubMeasure(calls),
    print: (l) => out.push(l),
    printError: (l) => err.push(l),
  });
  assert.equal(code, 0, err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dir, path.join(codexHome, 'pets', 'fixture-pet'));
  assert.equal(calls[0].sheetPath, path.join(codexHome, 'pets', 'fixture-pet', 'spritesheet.png'));

  const result = { ok: true, id: 'fixture-pet', dir: path.join(petsDir, 'fixture-pet'), errors: [] };
  const installed = assertInstalled(result, { id: 'fixture-pet' });
  assert.equal(installed.spritesheet, 'spritesheet.png');
  assert.equal(installed.persona, undefined);
  assert.deepEqual(installed.geometry, { frameW: 64, frameH: 64, columns: 4, rows: 4 });
  assert.deepEqual(fs.readdirSync(result.dir).sort(), [PACK_CONFIG_NAME, 'spritesheet.png'], 'pet.json is not copied');

  const text = out.join('\n');
  assert.ok(text.includes('npm start -- --pet fixture-pet'), text);
  assert.ok(text.includes('GANYU_PET=fixture-pet'), text);
  assert.ok(text.includes('docs/pet-config.md'), text);
  assert.ok(/measured/i.test(text) && /placeholder/i.test(text), text);
  for (const p of DRAFT_PLACEHOLDERS) assert.ok(text.includes(p.field), `the notice names ${p.field}`);
});

test('a zipped Codex pet is measured from a temp copy that is removed afterwards', (t) => {
  const dir = tmp(t, 'src');
  const scratch = tmp(t, 'scratch');
  const source = writeZip(dir, 'fixture.zip', zipOf(codexFiles(), { prefix: 'fixture-pet/' }));
  const calls = [];
  const result = installPack({ fs, source, petsDir: path.join(dir, 'pets'), measure: stubMeasure(calls), tmpdir: scratch });
  assertInstalled(result, { id: 'fixture-pet' });
  assert.equal(result.drafted, true);
  assert.deepEqual(result.placeholders, DRAFT_PLACEHOLDERS);
  assert.deepEqual(calls[0].files, ['pet.json', 'spritesheet.png']);
  assert.equal(path.basename(calls[0].dir), 'fixture-pet', 'the temp copy is named after the pack');
  assert.ok(calls[0].dir.startsWith(scratch));
  assert.deepEqual(fs.readdirSync(scratch), [], 'the temp copy is gone');
});

test('a measure that fails, or throws, refuses the pack with its own words', (t) => {
  const source = writeFolder(tmp(t, 'src'), codexFiles());
  assertRefused(t, { source, measure: () => ({ ok: false, errors: ['cannot find electron'] }), needle: 'cannot find electron' });
  assertRefused(t, {
    source,
    measure: () => {
      throw new Error('boom');
    },
    needle: 'boom',
  });
  assertRefused(t, { source, measure: undefined, needle: 'bare Codex pet' });
});

test('accessory sheets are installed beside the pet and still resolve', (t) => {
  const config = fixtureConfig({ accessories: [{ id: 'hat', sheet: 'layers/hat.png' }] });
  const check = validatePetConfig(config);
  if (!check.ok && check.errors.some((e) => e.includes('"accessories"'))) {
    t.skip('validatePetConfig does not know `accessories` yet');
    return;
  }
  const dir = tmp(t, 'src');
  const files = { ...packFiles(config), 'layers/hat.png': SHEET };
  const source = writeZip(dir, 'pip.zip', zipOf(files));
  const result = installPack({ fs, source, petsDir: path.join(dir, 'pets'), measure: noMeasure });
  const installed = assertInstalled(result);
  assert.equal(installed.accessories[0].sheet, 'layers/hat.png');
  assert.ok(fs.statSync(path.join(result.dir, 'layers', 'hat.png')).isFile());
  if (typeof petconfig.resolveAccessoryPaths === 'function') {
    const [hat] = petconfig.resolveAccessoryPaths(installed, path.join(result.dir, PACK_CONFIG_NAME));
    assert.ok(fs.statSync(hat.path).isFile());
  }

  // ...and one that is not in the pack is refused, like a missing spritesheet.
  const missing = writeZip(dir, 'nohat.zip', zipOf(packFiles(config)));
  assertRefused(t, { source: missing, needle: ['accessories[0].sheet', 'is not in the pack'] });
});

// ---------------------------------------------------------------------------
// 2. Refusals — the message, and a pets dir that has not moved
// ---------------------------------------------------------------------------

test('a corrupt zip is refused: truncated, garbage, a bad CRC', (t) => {
  const dir = tmp(t, 'src');
  const good = zipOf(packFiles());
  assertRefused(t, { source: writeZip(dir, 'cut.zip', good.subarray(0, good.length - 30)), needle: 'not a zip' });
  assertRefused(t, { source: writeZip(dir, 'cut-mid.zip', good.subarray(0, 200)), needle: 'not a zip' });
  assertRefused(t, { source: writeZip(dir, 'junk.zip', Buffer.from('this is not an archive at all, just words')), needle: 'not a zip' });
  const badCrc = makeZip(Object.entries(packFiles()).map(([name, data]) => ({ name, data, crc: name === 'sheet.png' ? 12345 : undefined })));
  assertRefused(t, { source: writeZip(dir, 'crc.zip', badCrc), needle: 'CRC' });
});

for (const evil of ['../evil.png', '/abs.png', 'C:/x.png', '..\\x.png', 'ok/../../x.png', '\\rooted.png', 'sheet.png:stream']) {
  test(`zip-slip is refused: ${JSON.stringify(evil)}`, (t) => {
    const dir = tmp(t, 'src');
    const entries = Object.entries(packFiles()).map(([name, data]) => ({ name, data }));
    entries.push({ name: evil, data: 'gotcha' });
    assertRefused(t, { source: writeZip(dir, 'slip.zip', makeZip(entries)), needle: ['refused', 'inside the pack'] });
  });
}

test('a symlink entry is refused', (t) => {
  const dir = tmp(t, 'src');
  const entries = Object.entries(packFiles()).map(([name, data]) => ({ name, data }));
  entries.push({ name: 'link.png', data: '/etc/passwd', method: 0, madeBy: (3 << 8) | 20, externalAttrs: (0o120777 << 16) >>> 0 });
  assertRefused(t, { source: writeZip(dir, 'link.zip', makeZip(entries)), needle: 'symbolic link' });
});

test('an encrypted entry is refused', (t) => {
  const dir = tmp(t, 'src');
  const entries = Object.entries(packFiles()).map(([name, data]) => ({ name, data, flags: name === 'sheet.png' ? 0x1 : 0 }));
  assertRefused(t, { source: writeZip(dir, 'enc.zip', makeZip(entries)), needle: 'encrypted' });
});

test('an unsupported compression method is refused', (t) => {
  const dir = tmp(t, 'src');
  const entries = Object.entries(packFiles()).map(([name, data]) => ({ name, data, method: name === 'sheet.png' ? 12 : 8 }));
  assertRefused(t, { source: writeZip(dir, 'bz.zip', makeZip(entries)), needle: 'compression method 12' });
});

test('a ZIP64 archive is refused', (t) => {
  const dir = tmp(t, 'src');
  const zip = zipOf(packFiles());
  zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16); // central directory offset -> the ZIP64 marker
  assertRefused(t, { source: writeZip(dir, 'z64.zip', zip), needle: 'ZIP64' });
});

test('a split archive, duplicate names and sizes that disagree with the data are refused', (t) => {
  const dir = tmp(t, 'src');
  const pack = () => Object.entries(packFiles()).map(([name, data]) => ({ name, data }));

  const split = zipOf(packFiles());
  split.writeUInt16LE(1, split.length - 22 + 4); // "this is disk 1"
  assertRefused(t, { source: writeZip(dir, 'split.zip', split), needle: 'multi-disk' });

  // Windows and macOS would write both of these to one file.
  const dupes = makeZip([...pack(), { name: 'SHEET.png', data: SHEET }]);
  assertRefused(t, { source: writeZip(dir, 'dupes.zip', dupes), needle: 'appears twice' });

  const stored = makeZip([...pack(), { name: 'x.bin', data: 'abc', method: 0, size: 4 }]);
  assertRefused(t, { source: writeZip(dir, 'stored.zip', stored), needle: 'two sizes disagree' });

  const short = makeZip([...pack(), { name: 'x.bin', data: Buffer.alloc(2000, 1), size: 1000 }]);
  assertRefused(t, { source: writeZip(dir, 'short.zip', short), needle: 'but its header says 1000' });
});

test('a folder pack whose sheet is reached through a link out of the pack is refused', (t) => {
  const dir = tmp(t, 'src');
  const outside = writeFolder(path.join(dir, 'outside'), { 'sheet.png': SHEET });
  const pack = writeFolder(path.join(dir, 'pack'), {
    [PACK_CONFIG_NAME]: JSON.stringify(fixtureConfig({ spritesheet: 'art/sheet.png' })),
  });
  try {
    // A junction needs no privilege on Windows; elsewhere the type is ignored and it is a dir symlink.
    fs.symlinkSync(outside, path.join(pack, 'art'), 'junction');
  } catch (err) {
    t.skip(`cannot make a directory link here (${err.code})`);
    return;
  }
  assertRefused(t, { source: pack, needle: ['art/sheet.png', 'a link to somewhere outside the pack'] });
});

test('oversize is refused: declared over the cap, and actual over the cap behind a lying header', (t) => {
  const dir = tmp(t, 'src');
  // A small injected cap that the pack itself (a few KB) fits under.
  const zipLimits = { maxTotalBytes: 64 * 1024 };
  const pack = Object.entries(packFiles()).map(([name, data]) => ({ name, data }));
  const declared = makeZip([...pack, { name: 'big.bin', data: Buffer.alloc(100 * 1024) }]);
  assertRefused(t, { source: writeZip(dir, 'declared.zip', declared), zipLimits, needle: 'declares more than 65,536 bytes' });

  // Declares 10 bytes, inflates to a megabyte. The cap, not the header, decides.
  const bomb = makeZip([...pack, { name: 'bomb.bin', data: Buffer.alloc(1024 * 1024), size: 10 }]);
  assertRefused(t, { source: writeZip(dir, 'bomb.zip', bomb), zipLimits, needle: ['inflates past 65,536 bytes', 'understates'] });

  // A zip file far bigger than the cap is refused before it is even read into memory.
  assertRefused(t, { source: writeZip(dir, 'huge.zip', declared), zipLimits: { maxTotalBytes: 1024 }, needle: 'far more than a pack may hold' });

  // And the same pack without the extra entry is under the cap, so it is the entry that was refused.
  const fine = installPack({ fs, source: writeZip(dir, 'fine.zip', makeZip(pack)), petsDir: path.join(dir, 'pets'), zipLimits, measure: noMeasure });
  assertInstalled(fine);
});

test('more entries than the cap is refused', (t) => {
  const dir = tmp(t, 'src');
  const entries = Object.entries(packFiles()).map(([name, data]) => ({ name, data }));
  for (let i = entries.length; i <= ZIP_MAX_ENTRIES; i++) entries.push({ name: `filler/${i}.txt`, data: '', method: 0 });
  assert.equal(entries.length, ZIP_MAX_ENTRIES + 1);
  assertRefused(t, { source: writeZip(dir, 'many.zip', makeZip(entries)), needle: `${ZIP_MAX_ENTRIES + 1} entries` });
});

test('a pack whose sheet is missing is refused', (t) => {
  const source = writeFolder(tmp(t, 'src'), { [PACK_CONFIG_NAME]: JSON.stringify(fixtureConfig()) });
  assertRefused(t, { source, needle: ['spritesheet "sheet.png"', 'is not in the pack'] });
});

test('a sheet path that leaves the pack is refused', (t) => {
  for (const spritesheet of ['../sheet.png', path.join(ROOT, 'assets', 'starter-pet.png'), '/sheet.png']) {
    const source = writeFolder(tmp(t, 'src'), packFiles(fixtureConfig({ spritesheet })));
    assertRefused(t, { source, needle: 'relative paths inside the pack' });
  }
});

test('an invalid config is refused with the validator\'s own messages, verbatim', (t) => {
  const config = fixtureConfig();
  config.animation.modes.idle = 9;
  config.geometry.columns = 0;
  const expected = validatePetConfig(config);
  assert.equal(expected.ok, false);
  const source = writeFolder(tmp(t, 'src'), packFiles(config));
  const result = assertRefused(t, { source, needle: expected.errors });
  assert.equal(result.errors.length, expected.errors.length);

  // And through the CLI, every one of them is printed, with exit 1.
  const err = [];
  const code = main([source, '--pets-dir', populatedPetsDir(t)], { fs, env: {}, home: null, printError: (l) => err.push(l), print: () => {} });
  assert.equal(code, 1);
  for (const msg of expected.errors) assert.ok(err.join('\n').includes(msg), `the CLI prints ${msg}`);
});

test('a config that is not JSON is refused', (t) => {
  const source = writeFolder(tmp(t, 'src'), { [PACK_CONFIG_NAME]: '{ nope', 'sheet.png': SHEET });
  assertRefused(t, { source, needle: 'is not valid JSON' });
});

test('an id that is not a safe directory name is refused', (t) => {
  for (const id of ['Bad Id', 'UPPER', '.hidden', 'a..b', 'x'.repeat(65)]) {
    const source = writeFolder(tmp(t, 'src'), packFiles(fixtureConfig({ id })));
    assertRefused(t, { source, needle: [JSON.stringify(id), 'cannot be installed'] });
  }
});

test('something that is not a pack at all is refused', (t) => {
  const dir = tmp(t, 'src');
  assertRefused(t, { source: writeFolder(path.join(dir, 'empty'), { 'readme.txt': 'hi' }), needle: 'not a pet pack' });
  assertRefused(t, { source: writeFolder(path.join(dir, 'half'), { 'pet.json': '{}' }), needle: 'no spritesheet.webp or spritesheet.png' });
  assertRefused(t, { source: writeZip(dir, 'notes.txt', 'hello'), needle: 'expected a folder or a .zip' });
  assertRefused(t, { source: path.join(dir, 'nowhere'), needle: 'cannot be read' });
});

test('a refusal into a pets dir that does not exist yet does not create it', (t) => {
  const petsDir = path.join(tmp(t, 'pets'), 'not-yet');
  const source = writeFolder(tmp(t, 'src'), { [PACK_CONFIG_NAME]: JSON.stringify(fixtureConfig()) });
  assertRefused(t, { source, petsDir, needle: 'is not in the pack' });
  assert.equal(fs.existsSync(petsDir), false);
});

test('a failed write removes the staging dir and nothing else', (t) => {
  const petsDir = populatedPetsDir(t);
  const before = listing(petsDir);
  const source = writeFolder(tmp(t, 'src'), packFiles());
  const failing = {
    ...fs,
    writeFileSync(file, ...rest) {
      if (String(file).endsWith(PACK_CONFIG_NAME)) {
        const e = new Error('disk full');
        e.code = 'ENOSPC';
        throw e;
      }
      return fs.writeFileSync(file, ...rest);
    },
  };
  const result = installPack({ fs: failing, source, petsDir, measure: noMeasure });
  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('ENOSPC'));
  assert.deepEqual(listing(petsDir), before);
});

// ---------------------------------------------------------------------------
// 3. Replacing an installed pet
// ---------------------------------------------------------------------------

test('an existing id is refused without force, and backed up with it', (t) => {
  const petsDir = path.join(tmp(t, 'pets'), 'pets');
  const oldSource = writeFolder(tmp(t, 'old'), packFiles(fixtureConfig({ displayName: 'Old Pip' })));
  const newSource = writeFolder(tmp(t, 'new'), packFiles(fixtureConfig({ displayName: 'New Pip' })));
  assertInstalled(installPack({ fs, source: oldSource, petsDir, measure: noMeasure }));

  assertRefused(t, { source: newSource, petsDir, needle: ['already installed', '--force'] });

  const forced = installPack({ fs, source: newSource, petsDir, force: true, now: () => 1234, measure: noMeasure });
  assertInstalled(forced);
  assert.equal(forced.backup, path.join(petsDir, 'starter.bak-1234'));
  const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, PACK_CONFIG_NAME), 'utf8')).displayName;
  assert.equal(read(path.join(petsDir, 'starter')), 'New Pip');
  assert.equal(read(forced.backup), 'Old Pip');
  assert.deepEqual(fs.readdirSync(petsDir).sort(), ['starter', 'starter.bak-1234']);
});

test('with force, a final rename that fails puts the old copy back', (t) => {
  const petsDir = path.join(tmp(t, 'pets'), 'pets');
  assertInstalled(installPack({ fs, source: writeFolder(tmp(t, 'old'), packFiles(fixtureConfig({ displayName: 'Old Pip' }))), petsDir, measure: noMeasure }));
  const before = listing(petsDir);

  let renames = 0;
  const flaky = {
    ...fs,
    renameSync(from, to) {
      renames += 1;
      if (renames === 2) {
        const e = new Error('I/O error');
        e.code = 'EIO';
        throw e;
      }
      return fs.renameSync(from, to);
    },
  };
  const source = writeFolder(tmp(t, 'new'), packFiles(fixtureConfig({ displayName: 'New Pip' })));
  const result = installPack({ fs: flaky, source, petsDir, force: true, measure: noMeasure });
  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('EIO'));
  assert.equal(renames, 3, 'old -> bak, staging -> id (fails), bak -> id');
  assert.deepEqual(listing(petsDir), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(petsDir, 'starter', PACK_CONFIG_NAME), 'utf8')).displayName, 'Old Pip');
});

// ---------------------------------------------------------------------------
// 4. Where the pets dir is
// ---------------------------------------------------------------------------

test('defaultUserPetsDir follows Electron userData on every platform, and GANYU_PETS_DIR beats it', () => {
  assert.equal(
    defaultUserPetsDir({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Roaming\\ganyu-pet\\pets',
  );
  assert.equal(
    defaultUserPetsDir({ env: {}, platform: 'win32', home: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Roaming\\ganyu-pet\\pets',
    'no APPDATA falls back to the folder it always is',
  );
  assert.equal(
    defaultUserPetsDir({ env: {}, platform: 'darwin', home: '/Users/u' }),
    '/Users/u/Library/Application Support/ganyu-pet/pets',
  );
  assert.equal(defaultUserPetsDir({ env: { XDG_CONFIG_HOME: '/x/cfg' }, platform: 'linux', home: '/home/u' }), '/x/cfg/ganyu-pet/pets');
  assert.equal(defaultUserPetsDir({ env: {}, platform: 'linux', home: '/home/u' }), '/home/u/.config/ganyu-pet/pets');
  assert.equal(defaultUserPetsDir({ env: { XDG_CONFIG_HOME: '  ' }, platform: 'linux', home: '/home/u' }), '/home/u/.config/ganyu-pet/pets');

  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(
      defaultUserPetsDir({ env: { GANYU_PETS_DIR: '/custom/pets', APPDATA: 'C:\\A', XDG_CONFIG_HOME: '/x' }, platform, home: '/home/u' }),
      '/custom/pets',
      `GANYU_PETS_DIR wins on ${platform}`,
    );
    assert.notEqual(defaultUserPetsDir({ env: { GANYU_PETS_DIR: '   ' }, platform, home: '/home/u' }), '   ', 'blank is unset');
  }
  assert.equal(defaultUserPetsDir({ env: {}, platform: 'linux', home: null }), null, 'no home and no override: no dir');
  assert.equal(defaultUserPetsDir({ env: {}, platform: 'darwin', home: '' }), null);
});

test('isSafePetId accepts exactly what findPetConfig accepts as a name', (t) => {
  assert.equal(isSafePetId('ganyu--chenxin-dlut'), true, 'the built-in id must be installable');
  const names = ['ganyu--chenxin-dlut', 'starter', 'a.b', 'a_b-c', 'a..b', '.staging-x', 'UPPER', 'has space', '-lead', 'a/b', 'a\\b', '', 'x'.repeat(64), 'x'.repeat(65)];
  if (typeof petconfig.findPetConfig !== 'function') {
    t.skip('findPetConfig is not exported yet');
    return;
  }
  for (const name of names) {
    const found = petconfig.findPetConfig({ fs: { existsSync: () => false }, name });
    const mainSaysSafe = !found.errors.some((e) => e.includes('not a safe name'));
    assert.equal(isSafePetId(name), mainSaysSafe, `the installer and main disagree about ${JSON.stringify(name)}`);
  }
});

// ---------------------------------------------------------------------------
// The CLI around it
// ---------------------------------------------------------------------------

test('the CLI refuses a bad Codex id and a missing one with exit 1 and a clear line', (t) => {
  const petsDir = path.join(tmp(t, 'pets'), 'pets');
  const codexHome = tmp(t, 'codex');
  const run = (argv) => {
    const err = [];
    const code = main(argv, { fs, env: {}, home: null, measure: noMeasure, print: () => {}, printError: (l) => err.push(l) });
    return { code, text: err.join('\n') };
  };
  const bad = run(['Not A Pet', '--pets-dir', petsDir, '--codex-home', codexHome]);
  assert.equal(bad.code, 1);
  assert.ok(bad.text.includes('not a Codex pet id either'), bad.text);
  const missing = run(['no-such-pet', '--pets-dir', petsDir, '--codex-home', codexHome]);
  assert.equal(missing.code, 1);
  assert.ok(missing.text.includes(`no Codex pet with that id at ${path.join(codexHome, 'pets', 'no-such-pet')}`), missing.text);
  const usage = run([]);
  assert.equal(usage.code, 1);
  assert.ok(usage.text.includes('no pack given') && usage.text.includes('usage:'), usage.text);
  assert.equal(fs.existsSync(petsDir), false, 'no refusal created the pets dir');
});

test('parseArgs reads every option and rejects what it does not know', () => {
  assert.deepEqual(parseArgs(['pip.zip', '--force', '--pets-dir', 'P', '--codex-home', 'C']), {
    ok: true,
    target: 'pip.zip',
    petsDir: 'P',
    force: true,
    codexHome: 'C',
    help: false,
    errors: [],
  });
  assert.deepEqual(parseArgs(['--pets-dir']).errors, ['--pets-dir needs a value', 'no pack given']);
  assert.deepEqual(parseArgs(['a', 'b', '--frobnicate']).errors, ['unexpected extra argument b', 'unknown option --frobnicate']);
});

// ---------------------------------------------------------------------------
// readZip on its own
// ---------------------------------------------------------------------------

test('readZip reads stored and deflated entries, skips directories, and ignores a local extra field the central one lacks', () => {
  const zip = makeZip([
    { name: 'dir/', data: '', method: 0 },
    { name: 'dir/a.txt', data: 'stored text', method: 0, localExtra: Buffer.from([0x55, 0x54, 0x05, 0x00, 1, 2, 3, 4, 5]) },
    { name: 'b.bin', data: SHEET, method: 8, centralExtra: Buffer.from([0x0a, 0x00, 0x00, 0x00]) },
  ]);
  const result = readZip(zip);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.entries.map((e) => e.name), ['dir/a.txt', 'b.bin']);
  assert.equal(result.entries[0].data.toString(), 'stored text');
  assert.ok(result.entries[1].data.equals(SHEET));
});

test('readZip never throws, whatever it is handed', () => {
  for (const input of [null, undefined, 'a string', Buffer.alloc(0), Buffer.alloc(21), Buffer.alloc(100, 0x50), zipOf(packFiles()).subarray(0, 60)]) {
    const result = readZip(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result.entries, []);
    assert.ok(result.errors.length > 0);
  }
});

test('readPack stages nothing', (t) => {
  const dir = tmp(t, 'src');
  writeFolder(dir, packFiles());
  const before = listing(dir);
  const pack = readPack({ fs, source: dir });
  assert.equal(pack.ok, true, pack.errors.join('\n'));
  assert.deepEqual([...pack.files.keys()], ['sheet.png']);
  assert.deepEqual(listing(dir), before);
});

// ---------------------------------------------------------------------------
// 5 & 6. analyze-pet: the real Electron draft, and importing it under node
// ---------------------------------------------------------------------------

/** The electron binary if it is installed — found without the package's own download-on-require. */
function electronBinary() {
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('electron/package.json'));
    const bin = path.join(pkgDir, 'dist', fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim());
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

test('a real Codex draft: analyze-pet under Electron measures a generated pet as 4x4 of 64', { timeout: 120_000 }, (t) => {
  const bin = electronBinary();
  if (!bin) {
    t.skip('the electron binary is not installed (npm install)');
    return;
  }
  const codexHome = codexHomeWith(t);
  const source = path.join(codexHome, 'pets', 'fixture-pet');
  const petsDir = path.join(tmp(t, 'pets'), 'pets');
  const measure = createElectronMeasure({ fs, env: process.env, codexHome, tmpdir: tmp(t, 'measure'), electron: () => ({ ok: true, path: bin }) });
  const result = installPack({ fs, source, petsDir, measure });
  const installed = assertInstalled(result, { id: 'fixture-pet' });
  assert.equal(result.drafted, true);
  assert.deepEqual(result.placeholders, DRAFT_PLACEHOLDERS);
  assert.equal(validatePetConfig(installed).ok, true);
  assert.deepEqual(installed.geometry, { frameW: 64, frameH: 64, columns: 4, rows: 4 });
  assert.deepEqual(installed.animation.rows.map((r) => r.frames), [3, 4, 4, 2], 'the starter sheet\'s real frame counts');
});

test('analyze-pet imports under plain node and starts nothing', async () => {
  const mod = await import('../scripts/analyze-pet.mjs');
  for (const name of ['inferCount', 'framesInRow', 'draftConfig', 'findSheet']) {
    assert.equal(typeof mod[name], 'function', `${name} is exported`);
  }
  assert.ok(Array.isArray(mod.DRAFT_PLACEHOLDERS));

  // In a child, so "does not hang" is a timeout rather than a stuck test run.
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(ANALYZER).href)}); console.log('imported');`],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(child.signal, null, 'the import hung');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'imported');
  assert.equal(child.stderr, '');
});

test('the exported pure pieces still measure: the finest aligned grid wins, and frames are the leading run', () => {
  // 64px, a sprite in columns 2..13 of every 16px cell. 4 cells aligns 3/3; 8
  // cells puts a boundary through the middle of every sprite and scores 3/7.
  const emptyLine = Array.from({ length: 64 }, (_, x) => (x % 16 < 2 || x % 16 > 13 ? 1 : 0));
  assert.equal(inferCount(64, emptyLine).count, 4);
  assert.deepEqual(framesInRow([0.4, 0.4, 0, 0]), { frames: 2, gap: false });
  assert.deepEqual(framesInRow([0.4, 0.4, 0, 0.4]), { frames: 2, gap: true });
});

test('DRAFT_PLACEHOLDERS describes exactly what draftConfig leaves unmeasured', () => {
  const draft = draftConfig({ id: 'p', displayName: 'P', spritesheet: 's.png', cols: 4, rows: 3, cellW: 32, cellH: 32, frames: [2, 0, 4] });
  assert.equal(validatePetConfig(draft).ok, true, validatePetConfig(draft).errors.join('\n'));
  assert.deepEqual(DRAFT_PLACEHOLDERS.map((p) => p.field), [
    'animation.rows[].label',
    'animation.modes',
    'animation.walk',
    'animation.airborne',
    'animation.celebrate',
    'persona',
  ]);
  assert.ok(draft.animation.rows.every((r, i) => r.label === `TODO row ${i}`));
  assert.deepEqual(draft.animation.modes, { idle: 0, busy: 0, waiting: 0, failed: 0 });
  assert.deepEqual(draft.animation.walk, { right: 0, left: 0 });
  assert.equal(draft.animation.airborne, 0);
  assert.deepEqual(draft.animation.celebrate, []);
  assert.equal(draft.persona, undefined);
  assert.deepEqual(draft.animation.rows.map((r) => r.frames), [2, 0, 4], 'the frame counts are the measured ones');
});
