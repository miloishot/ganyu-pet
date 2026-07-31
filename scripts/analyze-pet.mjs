// Measure a Codex pet's spritesheet and emit a draft pet config.
//
//   npx electron scripts/analyze-pet.mjs <pet-id-or-path> [options]
//
//   --cols N       override the inferred column count
//   --rows N       override the inferred row count
//   --alpha N      opacity threshold, 0-255 (default 16)
//   --out FILE     write the draft config JSON here as well as printing it
//
// **Why this script exists.** `~/.codex/pets/<id>/pet.json` carries an id, a
// display name, a description, a path and a "kind" — and nothing whatsoever
// about the grid, the frame counts or what any row depicts. Every number the
// renderer needs has to be measured off the image, and the row *semantics* have
// to be looked at by a person. This script does the measuring and prints the
// table that makes the looking possible.
//
// **Why Electron.** The sheets are `.webp`, which node cannot decode and
// `nativeImage` does not read either. Chromium decodes it natively, so the sheet
// goes into a canvas in a hidden window and the alpha channel is read back from
// there. The image is handed over as a `data:` URL rather than a `file://` one
// so the canvas is never cross-origin-tainted and so this script writes nothing
// to disk unless asked to.

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = 'analyze-pet.mjs';

/** Alpha above which a pixel counts as ink. 16 clears webp's edge noise. */
const DEFAULT_ALPHA_THRESHOLD = 16;

/**
 * Opaque fraction above which a cell counts as a real frame. Measured on the
 * Ganyu sheet a blank cell reads exactly 0.0% and the thinnest real pose 34.5%,
 * so anything in this neighbourhood separates them; 0.5% is far enough above
 * zero to survive a few stray pixels in an otherwise empty cell.
 */
const MIN_FRAME_OPAQUE = 0.005;

/**
 * Fraction of interior cell boundaries that must fall in empty space before a
 * candidate grid is believed. See `inferCount` for why this is a threshold on
 * the *finest* acceptable grid rather than a score to maximise.
 */
const GRID_ALIGN_THRESHOLD = 0.8;

/** Bounds on the candidate search. A 4px cell is not a sprite. */
const MIN_CELL_PX = 8;
const MAX_CELL_COUNT = 64;

/**
 * Window padding around the frame, taken from the built-in pet: a 192x208 frame
 * sits in a 256x320 window, i.e. 64px of width and 112px of headroom for the
 * speech bubble (contracts.md §Window). A draft has to start somewhere and this
 * reproduces the one window we know looks right.
 */
const WINDOW_PAD_W = 64;
const WINDOW_PAD_H = 112;

/** Frame rate the renderer uses for everything but the walk rows. */
const DRAFT_DEFAULT_FPS = 8;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function parseArgs(argv) {
  // Electron puts the script in argv[1]; a bare `node` run puts it there too.
  const args = argv.slice(1).filter((a) => !a.endsWith(SCRIPT));
  const out = { target: null, cols: null, rows: null, alpha: DEFAULT_ALPHA_THRESHOLD, out: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const needsValue = (name) => {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`${name} needs a value`);
      return value;
    };
    if (arg === '--cols') out.cols = intArg('--cols', needsValue('--cols'));
    else if (arg === '--rows') out.rows = intArg('--rows', needsValue('--rows'));
    else if (arg === '--alpha') out.alpha = intArg('--alpha', needsValue('--alpha'));
    else if (arg === '--out') out.out = needsValue('--out');
    else if (arg === '--help' || arg === '-h') throw new UsageError('');
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else if (out.target === null) out.target = arg;
    else throw new UsageError(`unexpected extra argument ${arg}`);
  }

  if (!out.target) throw new UsageError('no pet given');
  if (out.alpha < 0 || out.alpha > 255) throw new UsageError('--alpha must be between 0 and 255');
  return out;
}

function intArg(name, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} expects a non-negative integer, got "${raw}"`);
  return n;
}

const USAGE = [
  `usage: npx electron scripts/${SCRIPT} <pet-id-or-path> [--cols N] [--rows N] [--alpha N] [--out FILE]`,
  '',
  '  <pet-id-or-path>  a Codex pet id (looked up under $CODEX_HOME/pets or ~/.codex/pets),',
  '                    a pet directory, or a path straight to a spritesheet image.',
].join('\n');

// ---------------------------------------------------------------------------
// Finding the sheet
// ---------------------------------------------------------------------------

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve `<pet-id-or-path>` to a sheet on disk, mirroring the lookup order
 * `resolveSpritePath` uses in `src/main/window.mjs` — CODEX_HOME first, then
 * `~/.codex`, then `pet.json`'s declared path. Reimplemented rather than
 * imported because that function resolves the one hardcoded pet and this one
 * takes an id, so they are different functions that happen to look at the same
 * directory.
 */
function findSheet(target, { env = process.env, home = os.homedir() } = {}) {
  if (isFile(target)) {
    const dir = path.dirname(target);
    return { sheetPath: path.resolve(target), petDir: dir, meta: readPetMeta(dir) };
  }

  const dirs = [];
  if (isDir(target)) dirs.push(target);
  const codexHome = env.CODEX_HOME && String(env.CODEX_HOME).trim()
    ? String(env.CODEX_HOME).trim()
    : path.join(home, '.codex');
  dirs.push(path.join(codexHome, 'pets', target));

  const tried = [];
  for (const dir of dirs) {
    if (!isDir(dir)) {
      tried.push(dir);
      continue;
    }
    const meta = readPetMeta(dir);
    const candidates = [];
    if (meta && typeof meta.spritesheetPath === 'string' && meta.spritesheetPath.trim()) {
      candidates.push(
        path.isAbsolute(meta.spritesheetPath)
          ? meta.spritesheetPath
          : path.join(dir, meta.spritesheetPath),
      );
    }
    candidates.push(path.join(dir, 'spritesheet.webp'), path.join(dir, 'spritesheet.png'));
    for (const candidate of candidates) {
      if (isFile(candidate)) {
        return { sheetPath: path.resolve(candidate), petDir: dir, meta };
      }
    }
    tried.push(`${dir} (no spritesheet in it)`);
  }

  throw new UsageError(
    [`cannot find a spritesheet for "${target}". Looked at:`, ...tried.map((t) => `  ${t}`)].join('\n'),
  );
}

function readPetMeta(dir) {
  const metaPath = path.join(dir, 'pet.json');
  if (!isFile(metaPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Upstream metadata is a nicety, not a dependency — an unparseable pet.json
    // costs the display name and nothing else.
    return null;
  }
}

const MIME_BY_EXT = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
};

// ---------------------------------------------------------------------------
// Grid inference
//
// The rule: a cell boundary on a real grid falls in the gap between two sprites,
// so the pixel columns either side of it are entirely transparent. Score a
// candidate by the fraction of its interior boundaries that land in such a gap.
//
// Score alone is not enough, because every *coarser* grid whose boundaries are a
// subset of the true ones scores just as well — on the Ganyu sheet, 4 columns of
// 384 aligns perfectly and is simply wrong. So the answer is the FINEST grid
// that still clears the threshold: 8 columns of 192 scores 7/7, while 16 columns
// of 96 puts boundaries through the middle of every sprite and scores 7/15.
// ---------------------------------------------------------------------------

function alignmentScore(count, cell, emptyLine) {
  if (count <= 1) return 1; // no interior boundaries to get wrong
  let clean = 0;
  for (let k = 1; k < count; k++) {
    const at = k * cell;
    if (emptyLine[at - 1] && emptyLine[at]) clean += 1;
  }
  return clean / (count - 1);
}

function inferCount(size, emptyLine) {
  const candidates = [];
  for (let n = 1; n <= MAX_CELL_COUNT; n++) {
    if (size % n !== 0) continue;
    const cell = size / n;
    if (cell < MIN_CELL_PX) continue;
    candidates.push({ count: n, cell, score: alignmentScore(n, cell, emptyLine) });
  }
  const accepted = candidates.filter((c) => c.score >= GRID_ALIGN_THRESHOLD);
  // count === 1 always scores 1, so `accepted` is never empty.
  const best = accepted.reduce((a, b) => (b.count > a.count ? b : a));
  return { ...best, candidates };
}

/**
 * Real frames in a row: the leading run of cells with ink in them. The count is
 * the *leading* run rather than the total, because that is what an animation can
 * loop over — a lone frame after a gap cannot be reached without a frame list,
 * and no sheet seen so far has one. A gap is reported so it is never silent.
 */
function framesInRow(percents) {
  let leading = 0;
  while (leading < percents.length && percents[leading] >= MIN_FRAME_OPAQUE) leading += 1;
  const total = percents.filter((p) => p >= MIN_FRAME_OPAQUE).length;
  return { frames: leading, gap: total !== leading };
}

// ---------------------------------------------------------------------------
// Measurement (in the hidden window)
// ---------------------------------------------------------------------------

const MEASURE_SHEET = `(async () => {
  const img = new Image();
  img.src = __SRC__;
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error('decoded to a zero-sized image');
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  const colHits = new Uint32Array(w);
  const rowHits = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > __ALPHA__) {
        ink[y * w + x] = 1;
        colHits[x] += 1;
        rowHits[y] += 1;
      }
    }
  }
  // Kept for the second pass, which needs the grid this pass is used to infer.
  window.__sheet = { w, h, ink };
  return {
    width: w,
    height: h,
    emptyCols: Array.from(colHits, (n) => (n === 0 ? 1 : 0)),
    emptyRows: Array.from(rowHits, (n) => (n === 0 ? 1 : 0)),
  };
})()`;

const MEASURE_CELLS = `(() => {
  const { w, h, ink } = window.__sheet;
  const cols = __COLS__, rows = __ROWS__;
  const cw = w / cols, ch = h / rows;
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      let n = 0;
      for (let y = r * ch; y < (r + 1) * ch; y++) {
        const base = y * w;
        for (let x = c * cw; x < (c + 1) * cw; x++) n += ink[base + x];
      }
      row.push(n / (cw * ch));
    }
    out.push(row);
  }
  return out;
})()`;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padStart(n);

function printCellTable(percents, frames) {
  const cols = percents[0].length;
  const header = ['  row'];
  for (let c = 0; c < cols; c++) header.push(pad(`c${c}`, 6));
  header.push(pad('frames', 8));
  console.log(header.join(' '));
  percents.forEach((row, r) => {
    const cells = row.map((p) => pad((p * 100).toFixed(1), 6));
    console.log([pad(r, 5), ...cells, pad(frames[r], 8)].join(' '));
  });
}

function draftConfig({ id, displayName, spritesheet, cols, rows, cellW, cellH, frames }) {
  return {
    schemaVersion: 1,
    id,
    displayName,
    spritesheet,
    geometry: { frameW: cellW, frameH: cellH, columns: cols, rows },
    animation: {
      defaultFps: DRAFT_DEFAULT_FPS,
      rows: frames.map((n, i) =>
        n === 0
          ? {
              label: `TODO row ${i}`,
              frames: 0,
              unmappedReason: 'TODO — measured as fully transparent; confirm the sheet really leaves this row blank',
            }
          : { label: `TODO row ${i}`, frames: n },
      ),
      // Placeholders, and they are wrong on purpose: every mode pointing at row 0
      // is obviously a draft, whereas a plausible-looking guess would be shipped.
      modes: { idle: 0, busy: 0, waiting: 0, failed: 0 },
      walk: { right: 0, left: 0 },
      airborne: 0,
      celebrate: [],
    },
    presentation: { windowWidth: cellW + WINDOW_PAD_W, windowHeight: cellH + WINDOW_PAD_H },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const opts = parseArgs(process.argv);
  const { sheetPath, petDir, meta } = findSheet(opts.target);

  const ext = path.extname(sheetPath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new UsageError(`${sheetPath}: unsupported image type "${ext || '(none)'}"`);
  }

  let bytes;
  try {
    bytes = fs.readFileSync(sheetPath);
  } catch (err) {
    throw new UsageError(`${sheetPath}: cannot be read (${(err && (err.code || err.name)) || 'unknown error'})`);
  }
  if (bytes.length === 0) throw new UsageError(`${sheetPath}: is empty`);

  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('about:blank');

  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  let sheet;
  try {
    sheet = await win.webContents.executeJavaScript(
      MEASURE_SHEET.replace('__SRC__', JSON.stringify(dataUrl)).replace('__ALPHA__', String(opts.alpha)),
    );
  } catch (err) {
    throw new UsageError(`${sheetPath}: could not be decoded (${(err && err.message) || 'unknown error'})`);
  }

  // ---- grid ----------------------------------------------------------------
  const colGuess = inferCount(sheet.width, sheet.emptyCols);
  const rowGuess = inferCount(sheet.height, sheet.emptyRows);

  const cols = opts.cols ?? colGuess.count;
  const rows = opts.rows ?? rowGuess.count;
  if (sheet.width % cols !== 0) {
    throw new UsageError(`--cols ${cols}: the sheet is ${sheet.width}px wide, which ${cols} does not divide evenly`);
  }
  if (sheet.height % rows !== 0) {
    throw new UsageError(`--rows ${rows}: the sheet is ${sheet.height}px tall, which ${rows} does not divide evenly`);
  }
  const cellW = sheet.width / cols;
  const cellH = sheet.height / rows;

  const percents = await win.webContents.executeJavaScript(
    MEASURE_CELLS.replace('__COLS__', String(cols)).replace('__ROWS__', String(rows)),
  );
  const rowInfo = percents.map(framesInRow);
  const frames = rowInfo.map((r) => r.frames);

  // ---- report --------------------------------------------------------------
  // Relative when the config lands beside the sheet (the layout docs/pet-config.md
  // recommends, and the one upstream's own pet.json uses); absolute otherwise —
  // a seven-deep `../../..` chain resolves today and breaks the moment either
  // file moves, which is a worse answer than a long one.
  const relFrom = opts.out ? path.dirname(path.resolve(opts.out)) : petDir;
  const rel = path.relative(relFrom, sheetPath).split(path.sep).join('/');
  const spritesheet = rel && !rel.startsWith('..') ? rel : sheetPath;

  console.log(`spritesheet  ${sheetPath}`);
  console.log(`             ${bytes.length.toLocaleString('en-US')} bytes, alpha threshold ${opts.alpha}`);
  console.log(`sheet        ${sheet.width} x ${sheet.height}`);
  console.log(
    `grid         ${cols} columns x ${rows} rows of ${cellW}x${cellH}` +
      `  (columns ${opts.cols === null ? `inferred, ${(colGuess.score * 100).toFixed(0)}% of boundaries fall in empty space` : 'given'}` +
      `; rows ${opts.rows === null ? `inferred, ${(rowGuess.score * 100).toFixed(0)}%` : 'given'})`,
  );
  console.log('');
  console.log('opaque % per cell — a blank cell reads 0.0, a real frame roughly 35-50');
  printCellTable(percents, frames);
  console.log('');
  console.log(`frames per row  [${frames.join(', ')}]`);

  const warnings = [];
  if (cols === 1 || rows === 1) {
    warnings.push(
      `the inferred grid is ${cols}x${rows}, which usually means the sprites touch their cell edges — pass --cols/--rows explicitly`,
    );
  }
  rowInfo.forEach((r, i) => {
    if (r.gap) {
      warnings.push(`row ${i} has a blank cell before its last real frame — the frame count is the leading run only`);
    }
  });
  if (frames.every((n) => n === 0)) {
    warnings.push('no row has any ink in it at all — check --alpha, or the image is blank');
  }
  if (warnings.length) {
    console.log('');
    for (const w of warnings) console.log(`warning: ${w}`);
  }

  // ---- draft ---------------------------------------------------------------
  const config = draftConfig({
    id: (meta && typeof meta.id === 'string' && meta.id.trim()) || path.basename(petDir),
    displayName:
      (meta && typeof meta.displayName === 'string' && meta.displayName.trim()) || path.basename(petDir),
    spritesheet,
    cols,
    rows,
    cellW,
    cellH,
    frames,
  });

  console.log('');
  console.log('--- DRAFT CONFIG — the geometry is measured, the semantics are NOT -----------');
  console.log('  Everything above this line came off the image. Everything below that names a');
  console.log('  row is a placeholder: nothing in the file, and nothing in the pixels, says');
  console.log('  which row is idle and which is a run cycle. Look at the sheet, replace every');
  console.log('  "TODO row N" label, then point modes/walk/airborne/celebrate at the right');
  console.log('  rows. See docs/pet-config.md — including why one Ganyu row is deliberately');
  console.log('  left unmapped.');
  console.log('-----------------------------------------------------------------------------');
  const json = JSON.stringify(config, null, 2);
  console.log(json);

  // The draft has to be valid against the schema it is a draft of, or the first
  // thing the owner does with it is debug this script instead of the pet.
  const { validatePetConfig } = await import('../src/main/petconfig.mjs');
  const check = validatePetConfig(config);
  if (!check.ok) {
    console.error('');
    console.error('internal error: the draft this script produced does not satisfy the schema:');
    for (const e of check.errors) console.error(`  ${e}`);
    return 1;
  }

  if (opts.out) {
    try {
      fs.writeFileSync(opts.out, `${json}\n`, 'utf8');
    } catch (err) {
      throw new UsageError(`--out ${opts.out}: cannot be written (${(err && (err.code || err.name)) || 'unknown error'})`);
    }
    console.log('');
    console.log(`wrote ${path.resolve(opts.out)}`);
  }

  return 0;
}

app.disableHardwareAcceleration();

app.whenReady().then(
  async () => {
    let code = 1;
    try {
      code = await run();
    } catch (err) {
      if (err instanceof UsageError) {
        if (err.message) console.error(`${SCRIPT}: ${err.message}`);
        console.error(USAGE);
      } else {
        console.error(`${SCRIPT}: ${(err && err.stack) || err}`);
      }
      code = 1;
    }
    app.exit(code);
  },
  (err) => {
    console.error(`${SCRIPT}: electron failed to start (${(err && err.message) || err})`);
    app.exit(1);
  },
);
