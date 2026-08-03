// Binding the app to a pet — the seam between `petconfig.mjs` and the modules
// that used to hold the character as constants.
//
// **This file exists separately because binding is destructive.** `window.mjs`
// and `renderer/pet.mjs` both expose live bindings that `usePetConfig` /
// `useSpriteConfig` rebind for the life of the module, which is exactly right
// for a value chosen once at boot and exactly wrong to do in the middle of a
// suite that asserts against the built-in pet. `node --test` gives each file its
// own process, so the rebinding here cannot reach `test/renderer.test.mjs` or
// `test/window.test.mjs`. Do not move these tests into those files.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PET_CONFIG, validatePetConfig } from '../src/main/petconfig.mjs';
import { BUILTIN_PERSONA, createPersona } from '../src/main/persona.mjs';
import { loadVoiceConfig } from '../src/main/voice.mjs';
import * as pet from '../src/renderer/pet.mjs';
import * as window from '../src/main/window.mjs';

// ---------------------------------------------------------------------------
// The duplicate, kept honest
// ---------------------------------------------------------------------------

test("the renderer's built-in geometry is DEFAULT_PET_CONFIG's, field for field", () => {
  // The renderer cannot import petconfig.mjs — that module pulls in `node:path`
  // and this one has to load where there are no node built-ins — so the built-in
  // pet's numbers are written twice. This is the test that makes the second copy
  // safe: change one and it fails naming the field, rather than the pet silently
  // animating at the wrong scale until someone looks at it.
  const { geometry, animation } = DEFAULT_PET_CONFIG;

  assert.equal(pet.FRAME_W, geometry.frameW, 'frameW');
  assert.equal(pet.FRAME_H, geometry.frameH, 'frameH');
  assert.equal(pet.FRAMES_PER_ROW, geometry.columns, 'columns');
  assert.equal(pet.ROW_COUNT, geometry.rows, 'rows');
  assert.equal(pet.SHEET_W, geometry.frameW * geometry.columns, 'sheet width');
  assert.equal(pet.SHEET_H, geometry.frameH * geometry.rows, 'sheet height');

  assert.deepEqual([...pet.ROW_FRAMES], animation.rows.map((r) => r.frames), 'per-row frame counts');
  assert.equal(pet.DEFAULT_FPS, animation.defaultFps, 'defaultFps');
  assert.deepEqual({ ...pet.MODE_ROW }, { ...animation.modes }, 'mode -> row');
  assert.deepEqual({ ...pet.WALK_ROW }, { ...animation.walk }, 'walk -> row');
  assert.deepEqual([...pet.CELEBRATE_PULSE], [...animation.celebrate], 'celebrate pulse');
  assert.equal(pet.AIRBORNE_ROW, animation.airborne, 'airborne row');

  // The per-row fps override, which the config carries as a field on the row
  // and the renderer flattens into a lookup.
  for (const [i, row] of animation.rows.entries()) {
    assert.equal(pet.fpsForRow(i), row.fps ?? animation.defaultFps, `fps for row ${i}`);
  }
});

// ---------------------------------------------------------------------------
// A second pet, which is the whole point
// ---------------------------------------------------------------------------

/** Nothing like Ganyu: a smaller sheet, fewer rows, a different row order. */
const OTHER_PET = Object.freeze({
  schemaVersion: DEFAULT_PET_CONFIG.schemaVersion,
  id: 'testcat',
  displayName: 'Testcat',
  spritesheet: 'cat.png',
  geometry: { frameW: 64, frameH: 64, columns: 4, rows: 4 },
  animation: {
    defaultFps: 12,
    rows: [
      { label: 'sleep', frames: 2, fps: 3 },
      { label: 'walk-right', frames: 4 },
      { label: 'walk-left', frames: 4 },
      { label: 'stare', frames: 3 },
    ],
    modes: { idle: 0, busy: 3, waiting: 3, failed: 3 },
    walk: { right: 1, left: 2 },
    airborne: 3,
    celebrate: [],
  },
  presentation: { windowWidth: 128, windowHeight: 160 },
  persona: {
    characterName: 'Testcat',
    ownerName: 'Somebody',
    identity:
      'You are a cat who has lived in this office for nine years. You sleep on the warm laptop, '
      + 'you judge everyone silently, and you have never once caught the mouse you spend every '
      + 'afternoon watching.',
    register: ['flat', 'unimpressed', 'short words'],
    voiceExamples: [
      ['a session starts', 'You are back, {owner}. I was asleep on the keyboard.'],
      ['something failed', 'It broke. I watched it break.'],
      ['a task finished', 'Done. I suppose that took you long enough.'],
      ['a quiet moment', 'Nothing is happening. This is my favourite part.'],
    ],
    messages: {
      greeting: ['You are back, {owner}.'],
      busy: ['{tool}. Fine.'],
      waiting: ['It wants something from you.'],
      failed: ['It broke.'],
      recovered: ['It is going again.'],
      celebrate: ['Done.'],
    },
  },
  voice: { provider: 'edge', name: 'en-GB-SoniaNeural', rate: '+10%', pitch: '-2st' },
});

test('the second pet is a legal config — every test below assumes it', () => {
  const result = validatePetConfig(OTHER_PET);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('a persona built from a config speaks as that pet, not as the built-in one', () => {
  const other = createPersona(OTHER_PET);

  assert.equal(other.characterName, 'Testcat');
  assert.equal(other.ownerName, 'Somebody');
  assert.ok(other.brainInstructions.includes('lived in this office for nine years'));
  assert.ok(!other.brainInstructions.includes('Ganyu'), 'no trace of the built-in character');
  assert.ok(!other.brainInstructions.includes('Kahweng'), "and none of the built-in pet's owner");

  // The register is the pet's; the banned corporate vocabulary is not.
  assert.ok(other.brainInstructions.includes('Register: flat, unimpressed, short words.'));
  assert.ok(other.brainInstructions.includes('Never corporate'));

  // And the built-in persona is untouched by having built another.
  assert.equal(BUILTIN_PERSONA.ownerName, 'Kahweng');
  assert.ok(BUILTIN_PERSONA.brainInstructions.includes('Ganyu'));
});

test('the seven rule blocks reach every pet, whatever its config says', () => {
  // The load-bearing claim of the whole design: a config supplies a character
  // and cannot drop the fixes. Each string below is one block that was written
  // because something went wrong once.
  const other = createPersona(OTHER_PET);
  for (const rule of [
    'Never invent a detail you were not given',
    'Talk about the work, not the machinery that carried it out',
    'Not everything that reaches you deserves a remark',
    'is his own wording, quoted',
    'You cannot edit a file, run a command, fix anything',
    'never reuse one as your line',
  ]) {
    assert.ok(other.brainInstructions.includes(rule), `missing rule block: ${rule}`);
  }
});

test('{owner} in a voice example is resolved, so it cannot go stale', () => {
  const other = createPersona(OTHER_PET);
  const [, line] = other.voiceExamples.find(([label]) => label === 'a session starts');
  assert.equal(line, 'You are back, Somebody. I was asleep on the keyboard.');
  assert.ok(!other.brainInstructions.includes('{owner}'), 'no unresolved slot reaches the model');
});

test('a config with no persona falls back rather than refusing to speak', () => {
  const { persona, ...noPersona } = OTHER_PET;
  assert.ok(persona, 'the fixture had one to remove');
  const built = createPersona(noPersona);
  assert.equal(built.ownerName, BUILTIN_PERSONA.ownerName);
});

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

test("the pet's voice block is used, and the machine's env still outranks it", () => {
  const fromPet = loadVoiceConfig({ pet: OTHER_PET });
  assert.equal(fromPet.enabled, true);
  assert.equal(fromPet.voice, 'en-GB-SoniaNeural');
  assert.equal(fromPet.rate, '+10%');
  assert.equal(fromPet.pitch, '-2st');

  // A shared pet config that could override a local mute would mean installing
  // someone's pet turns your speakers on.
  const muted = loadVoiceConfig({
    pet: OTHER_PET,
    envPath: '.env',
    fs: { readFileSync: () => 'GANYU_VOICE=off\n' },
  });
  assert.equal(muted.enabled, false);
  assert.equal(muted.reason, 'GANYU_VOICE is off');

  const renamed = loadVoiceConfig({
    pet: OTHER_PET,
    envPath: '.env',
    fs: { readFileSync: () => 'GANYU_VOICE_NAME=en-US-AriaNeural\n' },
  });
  assert.equal(renamed.voice, 'en-US-AriaNeural');
});

test('a pet that declares no voice is silent by design, and says so', () => {
  const silent = loadVoiceConfig({ pet: { ...OTHER_PET, voice: { provider: 'none' } } });
  assert.equal(silent.enabled, false);
  assert.equal(silent.reason, 'this pet has no voice');
});

// ---------------------------------------------------------------------------
// The destructive half. Everything above runs against the built-in pet; from
// here the module-level bindings are rebound and stay rebound.
// ---------------------------------------------------------------------------

test('usePetConfig binds the window to the pet, and PET_ID keeps naming the built-in', () => {
  const builtinSize = { ...window.WINDOW_SIZE };
  assert.deepEqual(window.windowSize(), builtinSize, 'unbound, it is the built-in size');
  assert.equal(window.petId(), DEFAULT_PET_CONFIG.id);

  const bound = window.usePetConfig(OTHER_PET);
  assert.deepEqual(bound.size, { width: 128, height: 160 });
  assert.equal(bound.petId, 'testcat');
  assert.deepEqual(window.windowSize(), { width: 128, height: 160 }, 'and every size default follows');

  // The exported constant is the *built-in* pet's, deliberately: it is what the
  // module starts bound to, not what it is bound to now.
  assert.deepEqual({ ...window.WINDOW_SIZE }, builtinSize);
  assert.equal(window.PET_ID, DEFAULT_PET_CONFIG.id);
});

test('the bound pet id chooses which directory the spritesheet is looked up in', () => {
  const seen = [];
  window.resolveSpritePath({
    env: { CODEX_HOME: '/codex' },
    exists: (p) => { seen.push(p); return false; },
  });
  assert.ok(seen.some((p) => p.includes('testcat')), `looked in: ${seen.join(', ')}`);

  // An explicit id beats the binding — the analyser and the setup CLI both need
  // to ask about a pet that is not the one currently running.
  const other = [];
  window.resolveSpritePath({
    id: 'someone-else',
    env: { CODEX_HOME: '/codex' },
    exists: (p) => { other.push(p); return false; },
  });
  assert.ok(other.some((p) => p.includes('someone-else')));
});

test('useSpriteConfig rebinds the renderer to the pet, and ignores nothing gracefully', () => {
  assert.equal(pet.useSpriteConfig(null), false, 'no config leaves the built-in pet in place');
  assert.equal(pet.useSpriteConfig(undefined), false);
  assert.equal(pet.FRAME_W, DEFAULT_PET_CONFIG.geometry.frameW, 'still the built-in');

  // The shape main actually sends — see `spriteBlock` in index.mjs.
  const anim = OTHER_PET.animation;
  const rowFps = {};
  anim.rows.forEach((row, i) => { if (row.fps) rowFps[i] = row.fps; });
  assert.equal(pet.useSpriteConfig({
    geometry: { ...OTHER_PET.geometry },
    animation: {
      rowFrames: anim.rows.map((r) => r.frames),
      defaultFps: anim.defaultFps,
      rowFps,
      modes: { ...anim.modes },
      walk: { ...anim.walk },
      airborne: anim.airborne,
      celebrate: [...anim.celebrate],
    },
  }), true);

  assert.equal(pet.FRAME_W, 64);
  assert.equal(pet.FRAME_H, 64);
  assert.equal(pet.FRAMES_PER_ROW, 4);
  assert.equal(pet.ROW_COUNT, 4);
  assert.equal(pet.SHEET_W, 256, 'sheet size is recomputed, not carried');
  assert.equal(pet.SHEET_H, 256);
  assert.deepEqual([...pet.ROW_FRAMES], [2, 4, 4, 3]);
  assert.equal(pet.DEFAULT_FPS, 12);
  assert.equal(pet.fpsForRow(0), 3, 'the row with its own rate');
  assert.equal(pet.fpsForRow(1), 12, 'and one without');
  assert.deepEqual({ ...pet.MODE_ROW }, { idle: 0, busy: 3, waiting: 3, failed: 3 });
  assert.deepEqual([...pet.CELEBRATE_PULSE], [], 'a sheet with no celebration pose is allowed');
  assert.equal(pet.AIRBORNE_ROW, 3);
});

test('after rebinding, the animation helpers answer for the new sheet', () => {
  // framesForRow is what the idle flicker came down to: wrapping at the grid
  // width rather than the real frame count draws transparent cells. A second pet
  // has to inherit the fix, not just the built-in numbers.
  assert.equal(pet.framesForRow(0), 2);
  assert.equal(pet.framesForRow(3), 3);
  assert.equal(pet.framesForRow(99), pet.FRAMES_PER_ROW, 'an unknown row falls back to the grid');

  assert.equal(pet.baseRowFor({ airborne: true }), 3, 'airborne beats everything');
  assert.equal(pet.baseRowFor({ walk: { dir: 'left' } }), 2);
  assert.equal(pet.baseRowFor({ mode: 'busy' }), 3);
  assert.equal(pet.baseRowFor({ mode: 'nonsense' }), 0, 'unknown modes fall back to the idle row');
});
