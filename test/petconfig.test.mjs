// Pet config tests — the schema that makes the app pet-agnostic.
//
// `fs` is injected and every path below is invented, so nothing here reads the
// disk, the real spritesheet or the installed pet directory. The persona half is
// exercised with a tiny synthetic character rather than Ganyu's own text: that
// text lives in `src/main/persona.mjs` and this module deliberately validates
// only the *shape*, so a test that imported the real persona would be asserting
// against the wrong file.
//
// Three themes:
//   1. the defaults — DEFAULT_PET_CONFIG is a transcription of the constants the
//      renderer already uses, so if it does not validate, the schema is wrong
//      about the pet that actually works;
//   2. the cross-field checks — a frame count wider than the grid, a mode
//      pointing off the end of the sheet, a row marked deliberately-unmapped that
//      something maps to anyway. These are the mistakes a human writing this by
//      hand actually makes, and the message has to say which one it was;
//   3. degradation — loadPetConfig reports, it never throws, whatever it is
//      handed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PET_CONFIG,
  MODE_NAMES,
  PERSONA_MESSAGE_KINDS,
  PET_SCHEMA_VERSION,
  WALK_DIRECTIONS,
  loadPetConfig,
  resolveSheetPath,
  validatePersonaConfig,
  validatePetConfig,
} from '../src/main/petconfig.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A deep, mutable copy of the frozen defaults, for tests that break one field. */
const clone = () => JSON.parse(JSON.stringify(DEFAULT_PET_CONFIG));

/** Every error joined, so a test can assert on the one message it cares about. */
const joined = (result) => result.errors.join('\n');

function assertRejects(result, needle) {
  assert.equal(result.ok, false, `expected the config to be rejected, got ok`);
  assert.ok(
    joined(result).includes(needle),
    `expected an error mentioning ${JSON.stringify(needle)}, got:\n${joined(result)}`,
  );
}

/**
 * node:fs shrunk to the one call loadPetConfig makes. `files` is path -> text;
 * a path absent from it throws ENOENT exactly as the real thing does.
 */
function fakeFs({ files = {}, fail = {} } = {}) {
  return {
    readFileSync(p) {
      if (fail[p]) {
        const err = new Error(`${fail[p]}: ${p}`);
        err.code = fail[p];
        throw err;
      }
      if (!(p in files)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
  };
}

/** A whole persona, small enough to read, with none of Ganyu's actual words. */
const SYNTHETIC_PERSONA = {
  characterName: 'Testcat',
  ownerName: 'Somebody',
  instructions: 'You are a cat. You are not helpful and you do not pretend to be.',
  voiceExamples: [
    ['a session starts', 'You are back. I was asleep on the keyboard.'],
    ['something failed', 'It broke. I watched it break.'],
  ],
  messages: Object.fromEntries(PERSONA_MESSAGE_KINDS.map((kind) => [kind, [`a ${kind} line`]])),
};

const personaClone = () => JSON.parse(JSON.stringify(SYNTHETIC_PERSONA));

// ---------------------------------------------------------------------------
// The built-in pet
// ---------------------------------------------------------------------------

test('DEFAULT_PET_CONFIG validates', () => {
  const result = validatePetConfig(DEFAULT_PET_CONFIG);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('DEFAULT_PET_CONFIG matches the constants the renderer actually uses', () => {
  // Transcribed from src/renderer/pet.mjs and src/main/window.mjs. If this drifts,
  // swapping the constants for the config is no longer a no-op — which is the one
  // property the defaults exist to have.
  const { geometry, animation, presentation } = DEFAULT_PET_CONFIG;
  assert.deepEqual(geometry, { frameW: 192, frameH: 208, columns: 8, rows: 9 });
  assert.deepEqual(
    animation.rows.map((r) => r.frames),
    [6, 8, 8, 4, 5, 8, 6, 6, 6],
    'ROW_FRAMES — measured off the sheet, not read from anywhere',
  );
  assert.deepEqual(animation.modes, { idle: 0, busy: 8, waiting: 6, failed: 5 });
  assert.deepEqual(animation.walk, { right: 1, left: 2 });
  assert.equal(animation.airborne, 4);
  assert.deepEqual(animation.celebrate, [4, 3]);
  assert.equal(animation.defaultFps, 8);
  assert.equal(animation.rows[1].fps, 6, 'WALK_FPS');
  assert.equal(animation.rows[2].fps, 6, 'WALK_FPS');
  assert.deepEqual(presentation, { windowWidth: 256, windowHeight: 320 });
});

test('the sheet geometry multiplies out to the real sheet', () => {
  const { frameW, frameH, columns, rows } = DEFAULT_PET_CONFIG.geometry;
  assert.equal(frameW * columns, 1536);
  assert.equal(frameH * rows, 1872);
});

test('row 7 is carried as deliberately unmapped, with its reason', () => {
  const row = DEFAULT_PET_CONFIG.animation.rows[7];
  assert.ok(row.unmappedReason, 'the run-in-place row must say why nothing plays it');
  assert.ok(row.unmappedReason.length > 20, 'the reason has to survive as prose, not as a flag');
  // And nothing may point at it — the validator enforces this, so prove the
  // defaults are the case it is enforcing against.
  const { modes, walk, airborne, celebrate } = DEFAULT_PET_CONFIG.animation;
  const pointed = [...Object.values(modes), ...Object.values(walk), airborne, ...celebrate];
  assert.equal(pointed.includes(7), false);
});

test('DEFAULT_PET_CONFIG is frozen all the way down', () => {
  assert.throws(() => {
    DEFAULT_PET_CONFIG.animation.rows[0].frames = 99;
  });
  assert.equal(DEFAULT_PET_CONFIG.animation.rows[0].frames, 6);
});

// ---------------------------------------------------------------------------
// Geometry and frame counts
// ---------------------------------------------------------------------------

test('a frame count wider than the grid is rejected, and says so', () => {
  const config = clone();
  config.animation.rows[3].frames = 9;
  const result = validatePetConfig(config);
  assertRejects(result, 'animation.rows[3].frames: 9 frames on a 8-column sheet');
  assert.ok(joined(result).includes('more frames than the grid is wide'));
});

test('a frame count exactly equal to the column count is fine', () => {
  const config = clone();
  config.animation.rows[0].frames = 8;
  assert.equal(validatePetConfig(config).ok, true);
});

test('a zero-frame row is rejected unless it is declared unmapped', () => {
  const config = clone();
  config.animation.rows[3].frames = 0;
  config.animation.modes.idle = 0;
  assertRejects(validatePetConfig(config), 'animation.rows[3].frames: 0');

  // The analyzer really does measure 0 for a blank row, so it has to be sayable.
  const ok = clone();
  ok.animation.rows[3].frames = 0;
  ok.animation.rows[3].unmappedReason = 'the sheet leaves this row blank';
  ok.animation.celebrate = [4]; // row 3 was in the celebrate pulse
  assert.equal(validatePetConfig(ok).ok, true);
});

test('a non-integer or negative frame count is rejected', () => {
  for (const bad of [-1, 2.5, '6', null]) {
    const config = clone();
    config.animation.rows[0].frames = bad;
    assertRejects(validatePetConfig(config), 'animation.rows[0].frames');
  }
});

test('the row array must have exactly one entry per row', () => {
  const short = clone();
  short.animation.rows.pop();
  assertRejects(validatePetConfig(short), 'animation.rows: 8 entries for a 9-row sheet');

  const long = clone();
  long.animation.rows.push({ label: 'extra', frames: 4 });
  assertRejects(validatePetConfig(long), 'animation.rows: 10 entries for a 9-row sheet');
});

test('geometry fields must be positive integers', () => {
  for (const key of ['frameW', 'frameH', 'columns', 'rows']) {
    for (const bad of [0, -8, 12.5, '8']) {
      const config = clone();
      config.geometry[key] = bad;
      assertRejects(validatePetConfig(config), `geometry.${key}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The mode map
// ---------------------------------------------------------------------------

test('a mode pointing past the end of the sheet is rejected by row number', () => {
  const config = clone();
  config.animation.modes.busy = 12;
  const result = validatePetConfig(config);
  assertRejects(result, 'animation.modes.busy: row 12 does not exist on a 9-row sheet');
  assert.ok(joined(result).includes('valid rows are 0-8'));
});

test('a negative or non-integer row index is rejected', () => {
  for (const bad of [-1, 1.5, '4', null]) {
    const config = clone();
    config.animation.modes.idle = bad;
    assertRejects(validatePetConfig(config), 'animation.modes.idle');
  }
});

test('every aggregate mode must be mapped', () => {
  for (const mode of MODE_NAMES) {
    const config = clone();
    delete config.animation.modes[mode];
    assertRejects(validatePetConfig(config), `animation.modes.${mode}: missing`);
  }
});

test('a mode that is not one of the four the state machine emits is rejected', () => {
  const config = clone();
  config.animation.modes.thinking = 3;
  assertRejects(validatePetConfig(config), 'unknown key "thinking"');
});

test('both walk directions must be mapped, in range', () => {
  for (const dir of WALK_DIRECTIONS) {
    const missing = clone();
    delete missing.animation.walk[dir];
    assertRejects(validatePetConfig(missing), `animation.walk.${dir}: missing`);

    const far = clone();
    far.animation.walk[dir] = 9;
    assertRejects(validatePetConfig(far), `animation.walk.${dir}: row 9 does not exist`);
  }
});

test('airborne is required and range-checked', () => {
  const missing = clone();
  delete missing.animation.airborne;
  assertRejects(validatePetConfig(missing), 'animation.airborne: missing');

  const far = clone();
  far.animation.airborne = 99;
  assertRejects(validatePetConfig(far), 'animation.airborne: row 99 does not exist on a 9-row sheet');
});

test('the celebrate pulse is range-checked per entry, and may be empty', () => {
  const bad = clone();
  bad.animation.celebrate = [4, 11];
  assertRejects(validatePetConfig(bad), 'animation.celebrate[1]: row 11 does not exist');

  const none = clone();
  none.animation.celebrate = [];
  assert.equal(validatePetConfig(none).ok, true, 'a sheet with no celebration pose is allowed');

  const missing = clone();
  delete missing.animation.celebrate;
  assertRejects(validatePetConfig(missing), 'animation.celebrate: missing');
});

test('a row cannot be both deliberately unmapped and mapped to', () => {
  const config = clone();
  config.animation.modes.busy = 7; // row 7 carries an unmappedReason
  const result = validatePetConfig(config);
  assertRejects(result, 'animation.rows[7]: marked unmapped');
  assert.ok(
    joined(result).includes('mode "busy" maps to it'),
    `the message has to name what points at it, got:\n${joined(result)}`,
  );
});

test('the unmapped contradiction is caught from every kind of mapping', () => {
  const cases = [
    ['walk', (c) => { c.animation.walk.left = 7; }, 'walk "left"'],
    ['airborne', (c) => { c.animation.airborne = 7; }, 'airborne'],
    ['celebrate', (c) => { c.animation.celebrate = [7]; }, 'the celebrate pulse'],
  ];
  for (const [name, mutate, expected] of cases) {
    const config = clone();
    mutate(config);
    const result = validatePetConfig(config);
    assertRejects(result, 'marked unmapped');
    assert.ok(joined(result).includes(expected), `${name}: expected ${expected} in:\n${joined(result)}`);
  }
});

test('an unmappedReason must be prose, not a boolean flag', () => {
  const config = clone();
  config.animation.rows[3].unmappedReason = true;
  assertRejects(validatePetConfig(config), 'animation.rows[3].unmappedReason');
});

// ---------------------------------------------------------------------------
// Required fields, versions and typos
// ---------------------------------------------------------------------------

test('a config for a different schema version is rejected outright', () => {
  const older = clone();
  older.schemaVersion = PET_SCHEMA_VERSION + 1;
  const result = validatePetConfig(older);
  assertRejects(result, `schemaVersion: expected ${PET_SCHEMA_VERSION}`);
  assert.ok(joined(result).includes('cannot be trusted to mean the same things'));

  const missing = clone();
  delete missing.schemaVersion;
  assertRejects(validatePetConfig(missing), 'schemaVersion: missing');
});

test('every required top-level field is required', () => {
  for (const key of ['id', 'displayName', 'spritesheet', 'geometry', 'animation', 'presentation']) {
    const config = clone();
    delete config[key];
    assertRejects(validatePetConfig(config), `${key}: missing (required)`);
  }
});

test('identity fields must be non-empty strings', () => {
  for (const key of ['id', 'displayName', 'spritesheet']) {
    for (const bad of ['', '   ', 42, null]) {
      const config = clone();
      config[key] = bad;
      assertRejects(validatePetConfig(config), `${key}: expected a non-empty string`);
    }
  }
});

test('a mistyped key is reported rather than silently ignored', () => {
  const top = clone();
  top.geomtry = top.geometry;
  assertRejects(validatePetConfig(top), 'pet config: unknown key "geomtry"');

  // The one that matters most: a row-level typo would animate at the default
  // frame rate forever and read as a problem with the sheet.
  const row = clone();
  row.animation.rows[1].fsp = 6;
  assertRejects(validatePetConfig(row), 'animation.rows[1]: unknown key "fsp"');
});

test('a per-row fps override must be a positive number', () => {
  for (const bad of [0, -6, '6']) {
    const config = clone();
    config.animation.rows[1].fps = bad;
    assertRejects(validatePetConfig(config), 'animation.rows[1].fps');
  }
  const ok = clone();
  ok.animation.rows[1].fps = 12.5;
  assert.equal(validatePetConfig(ok).ok, true, 'a fractional frame rate is legal');
});

test('a window smaller than the frame is rejected, because it would crop the pet', () => {
  const narrow = clone();
  narrow.presentation.windowWidth = 128;
  assertRejects(validatePetConfig(narrow), 'presentation.windowWidth: 128 is narrower than the 192px frame');

  const short = clone();
  short.presentation.windowHeight = 100;
  assertRejects(validatePetConfig(short), 'presentation.windowHeight: 100 is shorter than the 208px frame');
});

test('a window exactly the size of the frame is allowed', () => {
  const config = clone();
  config.presentation = { windowWidth: 192, windowHeight: 208 };
  assert.equal(validatePetConfig(config).ok, true);
});

test('anything that is not an object is rejected without throwing', () => {
  for (const bad of [null, undefined, 42, 'a config', [], true]) {
    const result = validatePetConfig(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.ok(joined(result).includes('pet config: expected an object'));
  }
});

test('a garbage animation block reports rather than throwing', () => {
  for (const bad of [null, 42, 'rows', []]) {
    const config = clone();
    config.animation = bad;
    const result = validatePetConfig(config);
    assert.equal(result.ok, false);
    assert.ok(joined(result).includes('animation:'));
  }
});

test('all problems are reported in one pass, not just the first', () => {
  const config = clone();
  config.animation.rows[0].frames = 40;
  config.animation.modes.waiting = 40;
  config.presentation.windowWidth = 4;
  const result = validatePetConfig(config);
  assert.ok(result.errors.length >= 3, `expected several errors, got:\n${joined(result)}`);
});

// ---------------------------------------------------------------------------
// loadPetConfig — reports, never throws
// ---------------------------------------------------------------------------

const CONFIG_PATH = 'C:\\pets\\testcat\\pet-config.json';

test('loadPetConfig reads and validates a good file', () => {
  const fs = fakeFs({ files: { [CONFIG_PATH]: JSON.stringify(DEFAULT_PET_CONFIG) } });
  const result = loadPetConfig({ fs, filePath: CONFIG_PATH });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.config.id, 'ganyu--chenxin-dlut');
  assert.deepEqual(result.config.animation.rows.map((r) => r.frames), [6, 8, 8, 4, 5, 8, 6, 6, 6]);
});

test('loadPetConfig returns ok:false for a missing file rather than throwing', () => {
  const fs = fakeFs({ files: {} });
  const result = loadPetConfig({ fs, filePath: CONFIG_PATH });
  assert.equal(result.ok, false);
  assert.ok(joined(result).includes('cannot be read (ENOENT)'));
  assert.ok(joined(result).includes(CONFIG_PATH));
});

test('loadPetConfig survives an unreadable file', () => {
  const fs = fakeFs({ fail: { [CONFIG_PATH]: 'EACCES' } });
  const result = loadPetConfig({ fs, filePath: CONFIG_PATH });
  assert.equal(result.ok, false);
  assert.ok(joined(result).includes('cannot be read (EACCES)'));
});

test('loadPetConfig survives a corrupt file', () => {
  const fs = fakeFs({ files: { [CONFIG_PATH]: '{ "id": "half-writ' } });
  const result = loadPetConfig({ fs, filePath: CONFIG_PATH });
  assert.equal(result.ok, false);
  assert.ok(joined(result).includes('is not valid JSON'));
});

test('loadPetConfig survives a file that is not JSON at all', () => {
  const fs = fakeFs({ files: { [CONFIG_PATH]: '<html><body>404 not found</body></html>' } });
  const result = loadPetConfig({ fs, filePath: CONFIG_PATH });
  assert.equal(result.ok, false);
  assert.ok(joined(result).includes('is not valid JSON'));
});

test('loadPetConfig rejects valid JSON that is not a config', () => {
  for (const text of ['42', '"a pet"', '[]', 'null']) {
    const fs = fakeFs({ files: { [CONFIG_PATH]: text } });
    const result = loadPetConfig({ fs, filePath: CONFIG_PATH });
    assert.equal(result.ok, false, `expected ${text} to be rejected`);
  }
});

test('loadPetConfig prefixes validation errors with the file they came from', () => {
  const broken = clone();
  broken.animation.rows[0].frames = 20;
  const fs = fakeFs({ files: { [CONFIG_PATH]: JSON.stringify(broken) } });
  const result = loadPetConfig({ fs, filePath: CONFIG_PATH });
  assert.equal(result.ok, false);
  assert.ok(result.errors.every((e) => e.startsWith(CONFIG_PATH)));
});

test('loadPetConfig reports a missing path or fs instead of throwing', () => {
  assert.equal(loadPetConfig({ fs: fakeFs(), filePath: '' }).ok, false);
  assert.equal(loadPetConfig({ fs: fakeFs(), filePath: null }).ok, false);
  assert.equal(loadPetConfig({ filePath: CONFIG_PATH }).ok, false);
  assert.equal(loadPetConfig().ok, false);
});

test('loadPetConfig never throws, whatever it is handed', () => {
  const hostile = {
    readFileSync() {
      throw new Error('the disk caught fire');
    },
  };
  assert.doesNotThrow(() => loadPetConfig({ fs: hostile, filePath: CONFIG_PATH }));
  assert.equal(loadPetConfig({ fs: hostile, filePath: CONFIG_PATH }).ok, false);
});

// ---------------------------------------------------------------------------
// resolveSheetPath
// ---------------------------------------------------------------------------

test('a relative spritesheet resolves against the config directory', () => {
  const resolved = resolveSheetPath({ spritesheet: 'spritesheet.webp' }, CONFIG_PATH);
  assert.ok(resolved.endsWith('spritesheet.webp'));
  assert.ok(resolved.includes('testcat'), `expected the pet directory in ${resolved}`);
});

test('an absolute spritesheet is left alone', () => {
  const abs = 'C:\\elsewhere\\sheet.webp';
  assert.equal(resolveSheetPath({ spritesheet: abs }, CONFIG_PATH), abs);
});

test('resolveSheetPath yields null rather than a broken path', () => {
  assert.equal(resolveSheetPath({}, CONFIG_PATH), null);
  assert.equal(resolveSheetPath(null, CONFIG_PATH), null);
  assert.equal(resolveSheetPath({ spritesheet: 'sheet.webp' }, ''), null);
});

// ---------------------------------------------------------------------------
// Persona — shape only
// ---------------------------------------------------------------------------

test('the synthetic persona validates', () => {
  const result = validatePersonaConfig(SYNTHETIC_PERSONA);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('a persona with no owner name is rejected', () => {
  const persona = personaClone();
  delete persona.ownerName;
  assertRejects(validatePersonaConfig(persona), 'persona.ownerName: missing (required)');

  for (const bad of ['', '  ', null, 7]) {
    const blank = personaClone();
    blank.ownerName = bad;
    assertRejects(validatePersonaConfig(blank), 'persona.ownerName');
  }
});

test('a persona with an empty voice-example list is rejected, and says why', () => {
  const persona = personaClone();
  persona.voiceExamples = [];
  const result = validatePersonaConfig(persona);
  assertRejects(result, 'persona.voiceExamples: empty');
  assert.ok(
    joined(result).includes('generic assistant'),
    'the message has to carry the reason, or the next author just deletes the list again',
  );
});

test('voice examples must be [label, line] pairs', () => {
  for (const bad of ['just a line', ['only-a-label'], ['a', 'b', 'c'], [1, 2]]) {
    const persona = personaClone();
    persona.voiceExamples = [bad];
    assertRejects(validatePersonaConfig(persona), 'persona.voiceExamples[0]');
  }
});

test('the character name and instructions are required', () => {
  for (const key of ['characterName', 'instructions']) {
    const persona = personaClone();
    delete persona[key];
    assertRejects(validatePersonaConfig(persona), `persona.${key}: missing (required)`);
  }
});

test('every canned message kind is required, non-empty', () => {
  for (const kind of PERSONA_MESSAGE_KINDS) {
    const missing = personaClone();
    delete missing.messages[kind];
    assertRejects(validatePersonaConfig(missing), `persona.messages.${kind}: missing`);

    const empty = personaClone();
    empty.messages[kind] = [];
    assertRejects(validatePersonaConfig(empty), `persona.messages.${kind}: empty`);

    const blank = personaClone();
    blank.messages[kind] = ['   '];
    assertRejects(validatePersonaConfig(blank), `persona.messages.${kind}[0]`);
  }
});

test('an unknown message kind is rejected', () => {
  const persona = personaClone();
  persona.messages.gloating = ['told you'];
  assertRejects(validatePersonaConfig(persona), 'persona.messages: unknown key "gloating"');
});

test('a non-object persona is rejected without throwing', () => {
  for (const bad of [null, 42, 'Ganyu', []]) {
    const result = validatePersonaConfig(bad);
    assert.equal(result.ok, false);
    assert.ok(joined(result).includes('persona: expected an object'));
  }
});

test('a persona carried inside a pet config is validated with it', () => {
  const good = clone();
  good.persona = personaClone();
  assert.equal(validatePetConfig(good).ok, true);

  const bad = clone();
  bad.persona = personaClone();
  bad.persona.voiceExamples = [];
  assertRejects(validatePetConfig(bad), 'persona.voiceExamples: empty');
});

test('the persona is optional — Ganyu\'s own still lives in persona.mjs', () => {
  assert.equal(DEFAULT_PET_CONFIG.persona, undefined);
  assert.equal(validatePetConfig(DEFAULT_PET_CONFIG).ok, true);
});
