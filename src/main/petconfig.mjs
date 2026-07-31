// Pet definition — schema, validator and loader.
//
// Today the app is welded to one character: the pet id, the grid geometry, the
// per-row frame counts and the mode->row map are constants spread across
// `src/main/window.mjs` and `src/renderer/pet.mjs`. This module is the shape
// they are destined to move into, so that dropping in a different Codex pet is
// a config file rather than a patch.
//
// **The upstream format is no help.** `~/.codex/pets/<id>/pet.json` carries
// exactly `{id, displayName, description, spritesheetPath, kind}` — no grid, no
// row semantics, no frame counts. Every number below had to be *measured* from
// the image (see `scripts/analyze-pet.mjs`), and the row semantics had to be
// eyeballed by a human. That is why this schema exists at all: it is the place
// to write down what the sheet does not say about itself.
//
// Pure: no Electron, no `node:fs` import, no clock. `loadPetConfig` takes its
// `fs` injected, exactly as `ledger.mjs` and `vault.mjs` do, so the tests drive
// a fake and never touch the disk.

import path from 'node:path';

/**
 * Bumped whenever a field changes meaning or a required field is added. A config
 * written for an older version is rejected rather than partially understood —
 * a half-read animation table is a pet that flickers, and the flicker would be
 * blamed on the sheet.
 */
export const PET_SCHEMA_VERSION = 1;

/**
 * The aggregate modes module B emits (contracts.md §Event normalization). All
 * four must be mapped: an unmapped mode silently falls back to idle, which is
 * how a pet ends up standing still through an entire failure.
 */
export const MODE_NAMES = Object.freeze(['idle', 'busy', 'waiting', 'failed']);

/** `walk.dir` on `ganyu:state`. Both directions are required for the same reason. */
export const WALK_DIRECTIONS = Object.freeze(['left', 'right']);

/** Speech's trigger kinds — the canned `MESSAGES` table is keyed by these. */
export const PERSONA_MESSAGE_KINDS = Object.freeze([
  'greeting',
  'busy',
  'waiting',
  'failed',
  'recovered',
  'celebrate',
]);

// Unknown keys are rejected rather than ignored. A mistyped optional key that is
// silently dropped is the worst failure this file can have: `fsp: 6` on a walk
// row animates at the default forever and looks like a sheet problem.
const TOP_KEYS = Object.freeze([
  'schemaVersion',
  'id',
  'displayName',
  'spritesheet',
  'geometry',
  'animation',
  'presentation',
  'persona',
]);
const GEOMETRY_KEYS = Object.freeze(['frameW', 'frameH', 'columns', 'rows']);
const ANIMATION_KEYS = Object.freeze([
  'defaultFps',
  'rows',
  'modes',
  'walk',
  'airborne',
  'celebrate',
]);
const ROW_KEYS = Object.freeze(['label', 'frames', 'fps', 'unmappedReason']);
const PRESENTATION_KEYS = Object.freeze(['windowWidth', 'windowHeight']);
const PERSONA_KEYS = Object.freeze([
  'characterName',
  'ownerName',
  'instructions',
  'voiceExamples',
  'messages',
]);

// ---------------------------------------------------------------------------
// Small predicates. Deliberately boring — every validation message below is
// built by hand rather than generated, because "expected string" is not a
// message anyone can act on and "row 9 on an 8-column sheet" is.
// ---------------------------------------------------------------------------

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** How a bad value is quoted back to the author. Never dumps a whole object. */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (value === null) return 'null';
  if (typeof value === 'object') return 'an object';
  return String(value);
}

function checkUnknownKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(`${where}: unknown key "${key}" — allowed keys are ${allowed.join(', ')}`);
    }
  }
}

/**
 * Row-index check shared by every mapping. Returns false (and pushes one precise
 * message) rather than throwing, so a config with five bad rows reports five
 * problems in one pass instead of one per edit-and-rerun cycle.
 */
function checkRowIndex(value, rowCount, where, errors) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${where}: expected a row index (a non-negative integer), got ${describe(value)}`);
    return false;
  }
  if (rowCount !== null && value >= rowCount) {
    errors.push(
      `${where}: row ${value} does not exist on a ${rowCount}-row sheet (valid rows are 0-${rowCount - 1})`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Persona
//
// SHAPE ONLY. Ganyu's actual text — OWNER_NAME, BRAIN_INSTRUCTIONS,
// VOICE_EXAMPLES, MESSAGES — stays in `src/main/persona.mjs`, where it is
// written next to the prompt that consumes it. Copying it here would create the
// two-sources-of-truth problem the repo complains about everywhere else; this
// module only says what a persona must *look* like for a new pet.
// ---------------------------------------------------------------------------

/**
 * Validate the persona half of a pet definition.
 *
 * `voiceExamples` is `[label, line]` pairs rather than bare lines because the
 * label is what stops the model averaging every example into one mood
 * (persona.mjs explains the defect at length). An empty list is rejected outright:
 * a persona with instructions and no examples is precisely the configuration
 * that produced a corporate assistant, so it is a broken persona, not a terse one.
 */
export function validatePersonaConfig(obj, { where = 'persona' } = {}) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${where}: expected an object, got ${describe(obj)}`] };
  }
  checkUnknownKeys(obj, PERSONA_KEYS, where, errors);

  for (const key of ['characterName', 'ownerName', 'instructions']) {
    if (obj[key] === undefined) {
      errors.push(`${where}.${key}: missing (required)`);
    } else if (!isNonEmptyString(obj[key])) {
      errors.push(`${where}.${key}: expected a non-empty string, got ${describe(obj[key])}`);
    }
  }

  if (obj.voiceExamples === undefined) {
    errors.push(`${where}.voiceExamples: missing (required)`);
  } else if (!Array.isArray(obj.voiceExamples)) {
    errors.push(`${where}.voiceExamples: expected an array, got ${describe(obj.voiceExamples)}`);
  } else if (obj.voiceExamples.length === 0) {
    errors.push(
      `${where}.voiceExamples: empty — the examples are what set the register, and instructions alone reliably produce a generic assistant`,
    );
  } else {
    obj.voiceExamples.forEach((pair, i) => {
      const at = `${where}.voiceExamples[${i}]`;
      if (!Array.isArray(pair) || pair.length !== 2) {
        errors.push(`${at}: expected a [label, line] pair, got ${describe(pair)}`);
        return;
      }
      if (!isNonEmptyString(pair[0])) {
        errors.push(`${at}[0]: expected a non-empty label, got ${describe(pair[0])}`);
      }
      if (!isNonEmptyString(pair[1])) {
        errors.push(`${at}[1]: expected a non-empty line, got ${describe(pair[1])}`);
      }
    });
  }

  if (obj.messages === undefined) {
    errors.push(`${where}.messages: missing (required)`);
  } else if (!isPlainObject(obj.messages)) {
    errors.push(`${where}.messages: expected an object, got ${describe(obj.messages)}`);
  } else {
    checkUnknownKeys(obj.messages, PERSONA_MESSAGE_KINDS, `${where}.messages`, errors);
    for (const kind of PERSONA_MESSAGE_KINDS) {
      const at = `${where}.messages.${kind}`;
      const variants = obj.messages[kind];
      if (variants === undefined) {
        errors.push(`${at}: missing — every trigger kind needs a canned fallback for when the brain is offline`);
        continue;
      }
      if (!Array.isArray(variants)) {
        errors.push(`${at}: expected an array of strings, got ${describe(variants)}`);
        continue;
      }
      if (variants.length === 0) {
        errors.push(`${at}: empty — this kind would have no line at all when the brain is unavailable`);
        continue;
      }
      variants.forEach((line, i) => {
        if (!isNonEmptyString(line)) {
          errors.push(`${at}[${i}]: expected a non-empty string, got ${describe(line)}`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Pet config
// ---------------------------------------------------------------------------

/**
 * Validate a whole pet definition. Returns `{ok, errors}` and never throws —
 * every path below either pushes a message or moves on, so a garbage input
 * produces a report rather than a stack trace.
 *
 * The checks that matter are the cross-field ones, because those are the ones a
 * human writing this by hand actually gets wrong: a frame count larger than the
 * grid is wide, a mode pointing at a row that is not on the sheet, and a row
 * marked deliberately-unmapped that something maps to anyway.
 */
export function validatePetConfig(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`pet config: expected an object, got ${describe(obj)}`] };
  }
  checkUnknownKeys(obj, TOP_KEYS, 'pet config', errors);

  if (obj.schemaVersion === undefined) {
    errors.push('schemaVersion: missing (required)');
  } else if (obj.schemaVersion !== PET_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: expected ${PET_SCHEMA_VERSION}, got ${describe(obj.schemaVersion)} — this config was written for a different schema and its fields cannot be trusted to mean the same things`,
    );
  }

  for (const key of ['id', 'displayName', 'spritesheet']) {
    if (obj[key] === undefined) {
      errors.push(`${key}: missing (required)`);
    } else if (!isNonEmptyString(obj[key])) {
      errors.push(`${key}: expected a non-empty string, got ${describe(obj[key])}`);
    }
  }

  // ---- geometry ------------------------------------------------------------
  // `columns` and `rows` describe the *grid*; `frameW`/`frameH` one cell. The
  // sheet's own pixel dimensions are deliberately absent — they are the product
  // of these four, and a fifth number that must agree with four others is a
  // number that will one day disagree.
  let columns = null;
  let rowCount = null;
  if (obj.geometry === undefined) {
    errors.push('geometry: missing (required)');
  } else if (!isPlainObject(obj.geometry)) {
    errors.push(`geometry: expected an object, got ${describe(obj.geometry)}`);
  } else {
    checkUnknownKeys(obj.geometry, GEOMETRY_KEYS, 'geometry', errors);
    for (const key of GEOMETRY_KEYS) {
      const value = obj.geometry[key];
      if (value === undefined) {
        errors.push(`geometry.${key}: missing (required)`);
      } else if (!isPosInt(value)) {
        errors.push(`geometry.${key}: expected a positive integer, got ${describe(value)}`);
      }
    }
    if (isPosInt(obj.geometry.columns)) columns = obj.geometry.columns;
    if (isPosInt(obj.geometry.rows)) rowCount = obj.geometry.rows;
  }

  // ---- animation -----------------------------------------------------------
  if (obj.animation === undefined) {
    errors.push('animation: missing (required)');
    return { ok: false, errors };
  }
  if (!isPlainObject(obj.animation)) {
    errors.push(`animation: expected an object, got ${describe(obj.animation)}`);
    return { ok: false, errors };
  }
  const anim = obj.animation;
  checkUnknownKeys(anim, ANIMATION_KEYS, 'animation', errors);

  if (anim.defaultFps === undefined) {
    errors.push('animation.defaultFps: missing (required)');
  } else if (!(Number.isFinite(anim.defaultFps) && anim.defaultFps > 0)) {
    errors.push(`animation.defaultFps: expected a positive number, got ${describe(anim.defaultFps)}`);
  }

  // One entry per physical row, in sheet order. Everything that varies per row —
  // the real frame count, an fps override, the human label, and whether the row
  // is deliberately left unreachable — lives in the same record, because four
  // parallel arrays indexed by row is four chances to get the indices out of step.
  const unmapped = new Map(); // row index -> reason, for the cross-check below
  if (anim.rows === undefined) {
    errors.push('animation.rows: missing (required)');
  } else if (!Array.isArray(anim.rows)) {
    errors.push(`animation.rows: expected an array, got ${describe(anim.rows)}`);
  } else {
    if (rowCount !== null && anim.rows.length !== rowCount) {
      errors.push(
        `animation.rows: ${anim.rows.length} ${anim.rows.length === 1 ? 'entry' : 'entries'} for a ${rowCount}-row sheet — there must be exactly one entry per row`,
      );
    }
    if (rowCount === null) rowCount = anim.rows.length;

    anim.rows.forEach((row, i) => {
      const at = `animation.rows[${i}]`;
      if (!isPlainObject(row)) {
        errors.push(`${at}: expected an object, got ${describe(row)}`);
        return;
      }
      checkUnknownKeys(row, ROW_KEYS, at, errors);

      const hasReason = row.unmappedReason !== undefined;
      if (hasReason) {
        if (!isNonEmptyString(row.unmappedReason)) {
          errors.push(
            `${at}.unmappedReason: expected a non-empty string saying why this row is left unreachable, got ${describe(row.unmappedReason)}`,
          );
        } else {
          unmapped.set(i, row.unmappedReason);
        }
      }

      if (row.frames === undefined) {
        errors.push(`${at}.frames: missing — the real (non-transparent) frame count for this row`);
      } else if (!Number.isInteger(row.frames) || row.frames < 0) {
        errors.push(`${at}.frames: expected a non-negative integer, got ${describe(row.frames)}`);
      } else if (columns !== null && row.frames > columns) {
        errors.push(
          `${at}.frames: ${row.frames} frames on a ${columns}-column sheet — a row cannot hold more frames than the grid is wide`,
        );
      } else if (row.frames === 0 && !hasReason) {
        // The analyzer really does measure 0 for a fully transparent row, so this
        // has to be representable — but only as something nothing plays, or the
        // frame loop divides a second by nothing.
        errors.push(
          `${at}.frames: 0 — a row with no real frames cannot be animated; give it an unmappedReason if the sheet genuinely leaves it blank`,
        );
      }

      if (row.fps !== undefined && !(Number.isFinite(row.fps) && row.fps > 0)) {
        errors.push(`${at}.fps: expected a positive number, got ${describe(row.fps)}`);
      }
      if (row.label !== undefined && !isNonEmptyString(row.label)) {
        errors.push(`${at}.label: expected a non-empty string, got ${describe(row.label)}`);
      }
    });
  }

  // Every row something points at, so a row marked "deliberately unmapped" can be
  // checked against reality. Without this the reason string is a comment, and a
  // comment that contradicts the code is worse than no comment.
  const referenced = new Map(); // row index -> what points at it

  function reference(row, by) {
    if (!referenced.has(row)) referenced.set(row, by);
  }

  if (anim.modes === undefined) {
    errors.push('animation.modes: missing (required)');
  } else if (!isPlainObject(anim.modes)) {
    errors.push(`animation.modes: expected an object, got ${describe(anim.modes)}`);
  } else {
    checkUnknownKeys(anim.modes, MODE_NAMES, 'animation.modes', errors);
    for (const mode of MODE_NAMES) {
      const at = `animation.modes.${mode}`;
      if (anim.modes[mode] === undefined) {
        errors.push(`${at}: missing — an unmapped mode falls back to idle, so the pet would stand still through it`);
        continue;
      }
      if (checkRowIndex(anim.modes[mode], rowCount, at, errors)) {
        reference(anim.modes[mode], `mode "${mode}"`);
      }
    }
  }

  if (anim.walk === undefined) {
    errors.push('animation.walk: missing (required)');
  } else if (!isPlainObject(anim.walk)) {
    errors.push(`animation.walk: expected an object, got ${describe(anim.walk)}`);
  } else {
    checkUnknownKeys(anim.walk, WALK_DIRECTIONS, 'animation.walk', errors);
    for (const dir of WALK_DIRECTIONS) {
      const at = `animation.walk.${dir}`;
      if (anim.walk[dir] === undefined) {
        errors.push(`${at}: missing — the pet strolls in both directions, so both need a row`);
        continue;
      }
      if (checkRowIndex(anim.walk[dir], rowCount, at, errors)) {
        reference(anim.walk[dir], `walk "${dir}"`);
      }
    }
  }

  if (anim.airborne === undefined) {
    errors.push('animation.airborne: missing — held in the cursor or mid-throw the pet is plainly not standing on anything, so this row outranks both the walk rows and the mode row');
  } else if (checkRowIndex(anim.airborne, rowCount, 'animation.airborne', errors)) {
    reference(anim.airborne, 'airborne');
  }

  // A pet with nothing to celebrate with is allowed: the pulse is the one part
  // of the map that has no fallback behaviour to break.
  if (anim.celebrate === undefined) {
    errors.push('animation.celebrate: missing (required) — use [] for a sheet with no celebration pose');
  } else if (!Array.isArray(anim.celebrate)) {
    errors.push(`animation.celebrate: expected an array of row indices, got ${describe(anim.celebrate)}`);
  } else {
    anim.celebrate.forEach((row, i) => {
      if (checkRowIndex(row, rowCount, `animation.celebrate[${i}]`, errors)) {
        reference(row, 'the celebrate pulse');
      }
    });
  }

  for (const [row, reason] of unmapped) {
    if (referenced.has(row)) {
      errors.push(
        `animation.rows[${row}]: marked unmapped ("${reason}") but ${referenced.get(row)} maps to it — a row is either deliberately unreachable or it is used, not both`,
      );
    }
  }

  // ---- presentation --------------------------------------------------------
  if (obj.presentation === undefined) {
    errors.push('presentation: missing (required)');
  } else if (!isPlainObject(obj.presentation)) {
    errors.push(`presentation: expected an object, got ${describe(obj.presentation)}`);
  } else {
    checkUnknownKeys(obj.presentation, PRESENTATION_KEYS, 'presentation', errors);
    for (const key of PRESENTATION_KEYS) {
      const value = obj.presentation[key];
      if (value === undefined) {
        errors.push(`presentation.${key}: missing (required)`);
      } else if (!isPosInt(value)) {
        errors.push(`presentation.${key}: expected a positive integer, got ${describe(value)}`);
      }
    }
    // The window holds the sprite plus bubble headroom (contracts.md §Window).
    // Smaller than the frame is not a small window, it is a cropped pet.
    const frameW = obj.geometry && obj.geometry.frameW;
    const frameH = obj.geometry && obj.geometry.frameH;
    if (isPosInt(frameW) && isPosInt(obj.presentation.windowWidth) && obj.presentation.windowWidth < frameW) {
      errors.push(
        `presentation.windowWidth: ${obj.presentation.windowWidth} is narrower than the ${frameW}px frame — the sprite would be clipped`,
      );
    }
    if (isPosInt(frameH) && isPosInt(obj.presentation.windowHeight) && obj.presentation.windowHeight < frameH) {
      errors.push(
        `presentation.windowHeight: ${obj.presentation.windowHeight} is shorter than the ${frameH}px frame — the sprite would be clipped`,
      );
    }
  }

  // ---- persona (optional) --------------------------------------------------
  // Optional because Ganyu's own persona still lives in `persona.mjs`; a config
  // for a *new* pet is where it would travel with the rest of the definition.
  if (obj.persona !== undefined) {
    const result = validatePersonaConfig(obj.persona);
    errors.push(...result.errors);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Read and validate a pet config from disk. **Never throws** — a missing file,
 * an unreadable one, a non-JSON one and a well-formed-but-wrong one all come
 * back the same way, because every caller wants to fall back to the built-in
 * pet rather than take the app down over a config file.
 *
 * `fs` is injected (`{readFileSync}` is the whole surface used).
 */
export function loadPetConfig({ fs, filePath } = {}) {
  if (!isNonEmptyString(filePath)) {
    return { ok: false, errors: [`loadPetConfig: expected a file path, got ${describe(filePath)}`] };
  }
  if (!fs || typeof fs.readFileSync !== 'function') {
    return { ok: false, errors: ['loadPetConfig: an fs with readFileSync must be injected'] };
  }

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // Report the code, not the message: a raw fs message is noise, and the code
    // is the part that says whether this is "no such file" or "permission".
    const code = (err && (err.code || err.name)) || 'unknown error';
    return { ok: false, errors: [`${filePath}: cannot be read (${code})`] };
  }

  let parsed;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : String(text));
  } catch (err) {
    const reason = (err && err.message) || 'unparseable';
    return { ok: false, errors: [`${filePath}: is not valid JSON (${reason})`] };
  }

  const result = validatePetConfig(parsed);
  if (!result.ok) {
    return { ok: false, errors: result.errors.map((msg) => `${filePath}: ${msg}`) };
  }
  return { ok: true, config: parsed, errors: [] };
}

/**
 * Where the spritesheet actually is. `spritesheet` is either absolute or
 * relative to the directory holding the config, mirroring how upstream's
 * `pet.json` states `spritesheetPath` relative to the pet directory — see
 * `resolveSpritePath` in `window.mjs`, which reads it exactly that way.
 */
export function resolveSheetPath(config, configPath) {
  const declared = config && config.spritesheet;
  if (!isNonEmptyString(declared)) return null;
  if (path.isAbsolute(declared)) return declared;
  if (!isNonEmptyString(configPath)) return null;
  return path.join(path.dirname(configPath), declared);
}

// ---------------------------------------------------------------------------
// The built-in pet
// ---------------------------------------------------------------------------

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Ganyu, exactly as she is hardcoded today. Every number here is transcribed
 * from a constant that already exists, so swapping the constants for this object
 * is a no-op — that is the point of writing it down before changing anything.
 *
 *   id             <- PET_ID                    (src/main/window.mjs)
 *   displayName    <- pet.json displayName      (~/.codex/pets/<id>/pet.json)
 *   spritesheet    <- 'spritesheet.webp'        (window.mjs resolveSpritePath)
 *   geometry.*     <- FRAME_W/FRAME_H/FRAMES_PER_ROW/ROW_COUNT (renderer/pet.mjs)
 *   rows[].frames  <- ROW_FRAMES                (renderer/pet.mjs)
 *   rows[].label   <- ROW                       (renderer/pet.mjs)
 *   rows[].fps     <- WALK_FPS via fpsForRow    (renderer/pet.mjs)
 *   defaultFps     <- DEFAULT_FPS               (renderer/pet.mjs)
 *   modes          <- MODE_ROW                  (renderer/pet.mjs)
 *   walk           <- WALK_ROW                  (renderer/pet.mjs)
 *   airborne       <- ROW.JUMP in baseRowFor    (renderer/pet.mjs)
 *   celebrate      <- CELEBRATE_PULSE           (renderer/pet.mjs)
 *   presentation   <- WINDOW_SIZE               (src/main/window.mjs)
 */
export const DEFAULT_PET_CONFIG = deepFreeze({
  schemaVersion: PET_SCHEMA_VERSION,
  id: 'ganyu--chenxin-dlut',
  displayName: 'Ganyu',
  spritesheet: 'spritesheet.webp',
  geometry: { frameW: 192, frameH: 208, columns: 8, rows: 9 },
  animation: {
    defaultFps: 8,
    // Measured from the installed sheet, not read from anywhere: the grid is 8
    // wide but only rows 1, 2 and 5 fill it, and the trailing cells of the rest
    // are fully transparent. Looping to 8 blinks the pet out — idle at 8fps lost
    // 250ms of every second.
    rows: [
      { label: 'idle', frames: 6 },
      { label: 'run-right', frames: 8, fps: 6 },
      { label: 'run-left', frames: 8, fps: 6 },
      { label: 'wave', frames: 4 },
      { label: 'jump', frames: 5 },
      { label: 'failed', frames: 8 },
      { label: 'waiting', frames: 6 },
      {
        label: 'busy-run-in-place',
        frames: 6,
        unmappedReason:
          'A run-in-place animation. Played while the pet is stationary it reads as jogging on the spot, so busy draws the standing review pose (row 8) instead; real locomotion already draws rows 1/2 through walk.',
      },
      { label: 'review', frames: 6 },
    ],
    modes: { idle: 0, busy: 8, waiting: 6, failed: 5 },
    walk: { right: 1, left: 2 },
    airborne: 4,
    celebrate: [4, 3],
  },
  presentation: { windowWidth: 256, windowHeight: 320 },
});
