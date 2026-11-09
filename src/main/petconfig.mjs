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

/**
 * Substitutions `messageFor` fills in a canned line (persona.mjs `SLOTS`). A
 * `{file}` in someone's config is not a typo the app can survive quietly: the
 * token stays in the text and the pet says "Running {file}…" out loud.
 */
export const MESSAGE_SLOTS = Object.freeze(['tool', 'project', 'owner']);

/**
 * The only substitution a voice example may carry. Examples are shown to the
 * model as finished speech, so a `{tool}` in one teaches it to say the braces —
 * but the owner's name has to be *some* token, because a config that spells it
 * out goes stale the moment `ownerName` changes and leaves the examples
 * greeting the previous owner. Resolved before the prompt is composed.
 */
export const EXAMPLE_SLOTS = Object.freeze(['owner']);

/** Synthesis backends `voice.mjs` knows how to drive. `none` is a mute pet. */
export const VOICE_PROVIDERS = Object.freeze(['edge', 'local', 'none']);

// Unknown keys are rejected rather than ignored. A mistyped optional key that is
// silently dropped is the worst failure this file can have: `fsp: 6` on a walk
// row animates at the default forever and looks like a sheet problem.
const TOP_KEYS = Object.freeze([
  // JSON has no comments and this is a file people edit by hand, so one is
  // allowed by name. Ignored entirely — it is not read, validated or passed on.
  '$comment',
  'schemaVersion',
  'id',
  'displayName',
  'spritesheet',
  'geometry',
  'animation',
  'presentation',
  'persona',
  'voice',
  'accessories',
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
  'identity',
  'register',
  'voiceExamples',
  'messages',
]);
const VOICE_KEYS = Object.freeze(['provider', 'name', 'rate', 'pitch']);
const ACCESSORY_KEYS = Object.freeze(['id', 'sheet', 'enabled']);

// An accessory id is what `GANYU_ACCESSORIES` names, typed by hand into an env
// var and split on commas, so it is kept to the characters that survive that
// trip: no spaces, no commas, no case to get wrong.
const ACCESSORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_NAME_CHARS = 64;

// A pet name becomes a directory under the user pets dir, so it has to be one
// safe path segment. Dots are allowed (Codex pet ids may carry them) but never
// first — which also keeps `.staging-*` and `..` from ever being a pet — and
// `..` is refused anywhere, because the pattern alone would admit `a..b`.
const PET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Small predicates. Deliberately boring — every validation message below is
// built by hand rather than generated, because "expected string" is not a
// message anyone can act on and "row 9 on an 8-column sheet" is.
// ---------------------------------------------------------------------------

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isSafeName = (v, pattern) =>
  typeof v === 'string' && v.length <= MAX_NAME_CHARS && pattern.test(v);

/**
 * True when `name` is safe to become `<pets dir>/<name>`. The one copy of the
 * rule: `findPetConfig` applies it to a name on the command line and
 * `petpack.mjs` to a pack's id before installing it.
 */
export function isSafePetName(name) {
  return isSafeName(name, PET_NAME_PATTERN) && !name.includes('..');
}

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
// **The config supplies the character; the code keeps the rules.** What looks
// like "the Ganyu prompt" in persona.mjs is nine blocks, and only two of them
// are about Ganyu: who she is, and her voice examples. The other seven are the
// bug fixes — react to the specific thing, never invent a detail, talk about
// the work and not the machinery that carried it out, not everything deserves a
// remark, how to read the owner's own wording, and the honesty rule about what
// a pet can and cannot actually do. Each of those cost a day to find.
//
// So this schema deliberately does **not** accept a whole prompt. It takes
// `identity` (who they are) and `register` (how they sound), and `persona.mjs`
// composes the seven rule blocks around them for every pet that will ever
// exist. A config that could replace them would let each new pet re-earn the
// corporate-assistant bug, the filename-narration bug and the fabrication bug,
// and the whole value of this repo is that those are already paid for.
//
// The same reasoning moved the guardrail tests here. `test/speech.test.mjs`
// checked Ganyu's literal strings for claims she could not back and for an
// over-represented ledger; checking one character's strings protects one
// character. As validation they protect every pet anyone writes.
// ---------------------------------------------------------------------------

/**
 * Claims no pet can back. Each entry is a claim to have *acted on the owner's
 * work*, or a promise to — not a list of forbidden English.
 *
 * This exists because of one line Ganyu actually said: "I've set that page
 * aside for you." Nothing in the app could set anything aside; she generalised
 * the claim out of a register full of secretarial competence, and the examples
 * are where the model reads that register from. So the examples are where it is
 * enforced. Note what is *not* here: "noted", "written down", "remember" — the
 * ledger (ledger.mjs) makes those true for every pet, which is the whole reason
 * it was built.
 */
export const FORBIDDEN_CLAIMS = Object.freeze([
  [/\bset\b[^.?!]{0,24}\baside\b/i, 'setting his work aside'],
  [/\b(fixed|repaired|patched|resolved)\b/i, 'fixing it'],
  [/\bhandled\b/i, 'handling it'],
  [/\b(postponed|deferred|rescheduled)\b/i, 'postponing it'],
  [/\btook care of\b/i, 'taking care of it'],
  [/\bsorted (it|that|them) out\b/i, 'sorting it out'],
  [/\b(filed|archived|submitted)\b/i, 'filing a real thing'],
  [/\bcleaned (it|that|them) up\b/i, 'cleaning up'],
  [/\bI'?(ve| have) (run|ran|edited|deleted|removed|changed|updated)\b/i, 'touching his files'],
  [/\bI'?ll (fix|handle|sort|file|run|edit|take care|deal with|look after)\b/i, 'promising to'],
  [/\bleave it (with|to) me\b/i, 'promising to'],
  [/\bshall I (bring|fetch|make|get)\b/i, 'offering to fetch something'],
]);

/**
 * The vocabulary a pet keeps records in. Matching on words rather than on whole
 * lines is the point: no single line was ever wrong, and a rewrite that swapped
 * "the ledger" for "my notes" in six places would have fixed nothing.
 */
export const RECORD_KEEPING = Object.freeze([
  /\bledgers?\b/i,
  /\brecords?\b/i,
  /\bnotes?\b/i,
  /\bnoted\b/i,
  /\bwrit(e|es|ten|ing)\b/i,
  /\bwrote\b/i,
  /\bjot(s|ted|ting)?\b/i,
]);

const mentionsRecordKeeping = (line) => RECORD_KEEPING.some((re) => re.test(line));

/**
 * Below this, the examples stop being a range and become a mood. Four is one
 * per aggregate mode — the fewest that can show the model that a failure and a
 * finish are not said in the same tone.
 */
export const MIN_VOICE_EXAMPLES = 4;

/**
 * The share of examples allowed to be about writing things down. Proportional
 * rather than fixed, because the defect was a ratio: six of twelve was not a
 * register but a theme, and the pet announced its ledger at every moment that
 * reached it until the owner asked what it even meant. Ganyu's twelve get three.
 */
const recordKeepingCap = (total) => Math.max(1, Math.floor(total / 4));

/** How short an identity may be before it stops being a character. */
export const MIN_IDENTITY_CHARS = 80;

const SLOT_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

/** Every `{token}` in a line, deduped, in the order they appear. */
function slotsIn(line) {
  const found = [];
  for (const [, name] of line.matchAll(SLOT_PATTERN)) {
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** One line, run past every claim no pet can back. Pushes at most one message. */
function checkClaims(line, at, errors) {
  for (const [pattern, claim] of FORBIDDEN_CLAIMS) {
    if (pattern.test(line)) {
      errors.push(
        `${at}: claims ${claim} — the pet watches, remembers and comments; it cannot act on his work, and a line that says otherwise teaches the model it can (${JSON.stringify(line)})`,
      );
      return;
    }
  }
}

/**
 * Validate the persona half of a pet definition.
 *
 * `voiceExamples` is `[label, line]` pairs rather than bare lines because the
 * label is what stops the model averaging every example into one mood
 * (persona.mjs explains the defect at length). A short list is rejected for the
 * same reason an empty one is: a persona with an identity and no examples is
 * precisely the configuration that produced a corporate assistant, so it is a
 * broken persona, not a terse one.
 */
export function validatePersonaConfig(obj, { where = 'persona' } = {}) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${where}: expected an object, got ${describe(obj)}`] };
  }
  checkUnknownKeys(obj, PERSONA_KEYS, where, errors);

  for (const key of ['characterName', 'ownerName', 'identity']) {
    if (obj[key] === undefined) {
      errors.push(`${where}.${key}: missing (required)`);
    } else if (!isNonEmptyString(obj[key])) {
      errors.push(`${where}.${key}: expected a non-empty string, got ${describe(obj[key])}`);
    }
  }

  // A one-line identity is the corporate-assistant bug in config form. The
  // model has to generalise a person out of this; "a helpful cat" gives it
  // nothing to generalise from and it falls back on its assistant defaults.
  if (isNonEmptyString(obj.identity) && obj.identity.trim().length < MIN_IDENTITY_CHARS) {
    errors.push(
      `${where}.identity: ${obj.identity.trim().length} characters — too thin to be a character. Say who they are, what they do, and one thing they are bad at; a sentence of adjectives produces a generic assistant with a name on it (at least ${MIN_IDENTITY_CHARS} characters)`,
    );
  }

  // Register is a small vocabulary, not prose: it is interpolated into a rules
  // block ("Register: soft, unhurried, plain warm words"), so a paragraph here
  // reads as an instruction and starts competing with the rules around it.
  if (obj.register === undefined) {
    errors.push(`${where}.register: missing (required) — a few words for how they sound, e.g. ["soft", "unhurried", "plain warm words"]`);
  } else if (!Array.isArray(obj.register)) {
    errors.push(`${where}.register: expected an array of short words or phrases, got ${describe(obj.register)}`);
  } else if (obj.register.length < 2) {
    errors.push(`${where}.register: ${obj.register.length} — one word is a label, not a register (at least 2)`);
  } else {
    obj.register.forEach((word, i) => {
      const at = `${where}.register[${i}]`;
      if (!isNonEmptyString(word)) {
        errors.push(`${at}: expected a non-empty string, got ${describe(word)}`);
      } else if (word.trim().length > 40) {
        errors.push(`${at}: ${word.trim().length} characters — this is interpolated into a one-line rule, so keep each entry to a word or short phrase`);
      }
    });
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
    if (obj.voiceExamples.length < MIN_VOICE_EXAMPLES) {
      errors.push(
        `${where}.voiceExamples: ${obj.voiceExamples.length} — too few to show a range, so the model reads them as one mood and says everything in it (at least ${MIN_VOICE_EXAMPLES}, one per aggregate mode)`,
      );
    }

    const labels = new Set();
    obj.voiceExamples.forEach((pair, i) => {
      const at = `${where}.voiceExamples[${i}]`;
      if (!Array.isArray(pair) || pair.length !== 2) {
        errors.push(`${at}: expected a [label, line] pair, got ${describe(pair)}`);
        return;
      }
      if (!isNonEmptyString(pair[0])) {
        errors.push(`${at}[0]: expected a non-empty label, got ${describe(pair[0])}`);
      } else {
        // Two examples labelled the same situation are two answers to one
        // question, and the model picks a blend of them rather than a range.
        const key = pair[0].trim().toLowerCase();
        if (labels.has(key)) {
          errors.push(`${at}[0]: the situation ${JSON.stringify(pair[0])} is already used — each example should cover a different moment`);
        }
        labels.add(key);
      }
      if (!isNonEmptyString(pair[1])) {
        errors.push(`${at}[1]: expected a non-empty line, got ${describe(pair[1])}`);
        return;
      }
      checkClaims(pair[1], `${at}[1]`, errors);
      // A stray slot in an example is a leaked template: examples are read as
      // finished speech, so "{tool} failed" teaches the model to say the braces.
      // `{owner}` is the one exception, and EXAMPLE_SLOTS says why.
      for (const slot of slotsIn(pair[1])) {
        if (!EXAMPLE_SLOTS.includes(slot)) {
          errors.push(
            `${at}[1]: contains {${slot}} — voice examples are shown as finished lines, so write the real words. Only ${EXAMPLE_SLOTS.map((s) => `{${s}}`).join(', ')} is substituted here`,
          );
        }
      }
    });

    const lines = obj.voiceExamples.filter((p) => Array.isArray(p) && isNonEmptyString(p[1]));
    const withRecord = lines.filter(([, line]) => mentionsRecordKeeping(line));
    const cap = recordKeepingCap(lines.length);
    if (withRecord.length > cap) {
      errors.push(
        `${where}.voiceExamples: ${withRecord.length} of ${lines.length} are about keeping notes (${withRecord.map(([label]) => label).join(', ')}) — at most ${cap}. Writing things down is the one thing the pet really does, and over-representing it here is how it becomes the only thing it ever says`,
      );
    }
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
          return;
        }
        checkClaims(line, `${at}[${i}]`, errors);
        // Unlike the examples, these really are templates — but only for the
        // two slots messageFor knows. An unknown one is spoken with its braces on.
        for (const slot of slotsIn(line)) {
          if (!MESSAGE_SLOTS.includes(slot)) {
            errors.push(
              `${at}[${i}]: unknown slot {${slot}} — it would be said out loud exactly like that. Known slots are ${MESSAGE_SLOTS.map((s) => `{${s}}`).join(', ')}`,
            );
          }
        }
      });

      // The bubble draws these verbatim, so the same skew reads the same way.
      const withRecord = variants.filter((line) => isNonEmptyString(line) && mentionsRecordKeeping(line));
      if (withRecord.length > 1) {
        errors.push(
          `${at}: ${withRecord.length} of ${variants.length} variants are about keeping notes — at most one per kind, or the pet says it every time this moment comes round`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate the voice half. Optional in full: a pet with no `voice` block is a
 * silent one, which is the state every pet was in before `voice.mjs` existed
 * and is still a perfectly good pet.
 *
 * `rate` and `pitch` are passed into SSML as written, so they are checked
 * against the shapes SSML accepts rather than left free — a malformed prosody
 * value does not error, it makes the whole utterance silently not render.
 */
export function validateVoiceConfig(obj, { where = 'voice' } = {}) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${where}: expected an object, got ${describe(obj)}`] };
  }
  checkUnknownKeys(obj, VOICE_KEYS, where, errors);

  if (obj.provider === undefined) {
    errors.push(`${where}.provider: missing (required) — one of ${VOICE_PROVIDERS.join(', ')}`);
  } else if (!VOICE_PROVIDERS.includes(obj.provider)) {
    errors.push(`${where}.provider: expected one of ${VOICE_PROVIDERS.join(', ')}, got ${describe(obj.provider)}`);
  }

  // Only the neural backend takes a voice name; the local one uses whatever SAPI
  // has installed, and a mute pet has nothing to name.
  if (obj.provider === 'edge') {
    if (obj.name === undefined) {
      errors.push(`${where}.name: missing — the edge backend needs a voice, e.g. "en-US-AvaMultilingualNeural"`);
    } else if (!isNonEmptyString(obj.name)) {
      errors.push(`${where}.name: expected a non-empty string, got ${describe(obj.name)}`);
    }
  } else if (obj.name !== undefined && !isNonEmptyString(obj.name)) {
    errors.push(`${where}.name: expected a non-empty string, got ${describe(obj.name)}`);
  }

  for (const [key, pattern, example] of [
    ['rate', /^[+-]\d{1,3}%$/, '"-5%"'],
    ['pitch', /^[+-]\d{1,3}(Hz|st|%)$/, '"+0Hz"'],
  ]) {
    if (obj[key] === undefined) continue;
    if (typeof obj[key] !== 'string' || !pattern.test(obj[key])) {
      errors.push(
        `${where}.${key}: expected a signed SSML value like ${example}, got ${describe(obj[key])} — an unparseable prosody value renders as silence rather than as an error`,
      );
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

  // ---- persona and voice ---------------------------------------------------
  // Both optional, for different reasons. A pet with no persona falls back to
  // the built-in one and still animates; a pet with no voice is simply silent.
  // Neither absence is worth refusing to start over.
  if (obj.persona !== undefined) {
    const result = validatePersonaConfig(obj.persona);
    errors.push(...result.errors);
  }
  if (obj.voice !== undefined) {
    const result = validateVoiceConfig(obj.voice);
    errors.push(...result.errors);
  }

  // ---- accessories ---------------------------------------------------------
  // Optional too: absent and `[]` both mean a pet with nothing drawn on top.
  if (obj.accessories !== undefined) checkAccessories(obj.accessories, errors);

  return { ok: errors.length === 0, errors };
}

/**
 * The `accessories` list. Pushes one message per problem, like everything above.
 *
 * Only the shape is checked here. Whether the sheet exists is main's question
 * (a missing file is dropped at boot with a log line, not refused, so one lost
 * hat cannot cost him the pet), and whether it is the right pixel size is the
 * renderer's, because that is the first place the image is actually decoded.
 */
function checkAccessories(list, errors) {
  if (!Array.isArray(list)) {
    errors.push(`accessories: expected an array of {id, sheet} entries, got ${describe(list)}`);
    return;
  }
  const seen = new Map(); // id -> index of its first use
  list.forEach((entry, i) => {
    const at = `accessories[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at}: expected an object, got ${describe(entry)}`);
      return;
    }
    checkUnknownKeys(entry, ACCESSORY_KEYS, at, errors);

    if (entry.id === undefined) {
      errors.push(`${at}.id: missing (required) — the name GANYU_ACCESSORIES uses to pick this layer`);
    } else if (!isSafeName(entry.id, ACCESSORY_ID_PATTERN)) {
      errors.push(
        `${at}.id: expected a lowercase name (a-z, 0-9, "-" and "_", starting with a letter or digit, at most ${MAX_NAME_CHARS} characters), got ${describe(entry.id)}`,
      );
    } else if (seen.has(entry.id)) {
      // Two layers under one name cannot be told apart from the env var, so
      // "hat" would switch on whichever happened to be listed first.
      errors.push(
        `${at}.id: "${entry.id}" is already used by accessories[${seen.get(entry.id)}] — GANYU_ACCESSORIES picks layers by id, so each must be unique`,
      );
    } else {
      seen.set(entry.id, i);
    }

    if (entry.sheet === undefined) {
      errors.push(`${at}.sheet: missing (required) — a transparent sheet the same pixel size as spritesheet`);
    } else if (!isNonEmptyString(entry.sheet)) {
      errors.push(`${at}.sheet: expected a non-empty string, got ${describe(entry.sheet)}`);
    }

    // A string "false" is truthy, so accepting it would switch the layer *on*.
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      errors.push(`${at}.enabled: expected true or false, got ${describe(entry.enabled)}`);
    }
  });
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
  return resolveBesideConfig(config && config.spritesheet, configPath);
}

/**
 * The one path rule, shared by the spritesheet and every accessory sheet: an
 * accessory that resolved differently from the pet it sits on would be found in
 * one checkout layout and lost in the next.
 */
function resolveBesideConfig(declared, configPath) {
  if (!isNonEmptyString(declared)) return null;
  if (path.isAbsolute(declared)) return declared;
  if (!isNonEmptyString(configPath)) return null;
  return path.join(path.dirname(configPath), declared);
}

/**
 * Every declared accessory with its sheet resolved, in config order:
 * `[{id, sheet, enabled, path}]`. `enabled` is filled in (default `true`) so no
 * caller has to remember the default; `path` is null exactly when
 * `resolveSheetPath` would be. A config with no `accessories` is `[]`.
 */
export function resolveAccessoryPaths(config, configPath) {
  const list = config && config.accessories;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => isPlainObject(entry) && isNonEmptyString(entry.id))
    .map((entry) => ({
      id: entry.id,
      sheet: entry.sheet,
      enabled: entry.enabled !== false,
      path: resolveBesideConfig(entry.sheet, configPath),
    }));
}

/**
 * Which accessories to draw on this machine: `{selected, warnings}`, `selected`
 * being ids in **config order** — the list order is the draw order, and letting
 * the env var reorder it would put the hat under the scarf on one machine and
 * over it on the next.
 *
 * `GANYU_ACCESSORIES` (passed in as `envValue`, trimmed):
 *   - unset, or empty / whitespace -> the config's own `enabled` flags;
 *   - exactly `none`               -> nothing at all;
 *   - `a,b`                        -> exactly those, whatever `enabled` says.
 *     Empty segments (`a,,b`, a trailing comma) are ignored. Ids are
 *     case-sensitive, like the config's. An id this pet does not have is one
 *     warning and is otherwise ignored — it is far more likely a typo than a
 *     reason to refuse to start, and the pet is still recognisably the pet.
 *
 * `none` counts only as the whole value; inside a list it is just an unknown id.
 */
export function selectAccessories(config, envValue) {
  const declared = resolveAccessoryPaths(config, null);
  const raw = typeof envValue === 'string' ? envValue.trim() : '';

  if (raw === '') {
    return { selected: declared.filter((a) => a.enabled).map((a) => a.id), warnings: [] };
  }
  if (raw === 'none') return { selected: [], warnings: [] };

  const wanted = new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''));
  const known = declared.map((a) => a.id);
  const warnings = [];
  for (const id of wanted) {
    if (!known.includes(id)) {
      const has = known.length > 0 ? `it has: ${known.join(', ')}` : 'it has none';
      warnings.push(`GANYU_ACCESSORIES names "${id}", which this pet does not have (${has}) — ignored`);
    }
  }
  return { selected: known.filter((id) => wanted.has(id)), warnings };
}

/**
 * Where a pet asked for by name lives: `{ok, source, filePath, errors}`, with
 * `source` one of `'user' | 'repo' | 'builtin'` (null when not ok). It finds; it
 * does not load — `loadPetConfig` does that, and a find that also validated
 * would be the second loader this file exists to prevent.
 *
 * Looked up in order, and **the first place that has the file decides**:
 *   1. `<userPetsDir>/<name>/ganyu-pet.json` — what `add-pet` installs;
 *   2. `<repoPetsDir>/<name>.json`            — the pets that ship with the repo;
 *   3. the built-in pet, only when `name` is its own id (`filePath` null).
 * A user copy therefore beats the repo's even when it turns out to be broken.
 * That is deliberate: falling through to a different file than the one he
 * installed would run a pet he did not ask for and look like the install
 * was ignored.
 *
 * `fs` is injected and only `existsSync` is used. `userPetsDir` may be null (no
 * user dir on this machine, or a caller that does not want one).
 */
export function findPetConfig({ fs, name, userPetsDir = null, repoPetsDir = null } = {}) {
  const fail = (msg) => ({ ok: false, source: null, filePath: null, errors: [msg] });

  // Before any lookup: the name becomes a path segment, and one that is not
  // safe must not reach `path.join` at all.
  if (!isSafePetName(name)) {
    return fail(
      `pet name ${describe(name)} is not a safe name — lowercase letters, digits, ".", "-" and "_", starting with a letter or digit, no "..", at most ${MAX_NAME_CHARS} characters`,
    );
  }
  if (!fs || typeof fs.existsSync !== 'function') {
    return fail('findPetConfig: an fs with existsSync must be injected');
  }
  const exists = (p) => {
    try {
      return Boolean(fs.existsSync(p));
    } catch {
      return false; // a lookup that cannot be made is a place that does not have it
    }
  };

  const places = [];
  if (isNonEmptyString(userPetsDir)) {
    places.push(['user', path.join(userPetsDir, name, 'ganyu-pet.json')]);
  }
  if (isNonEmptyString(repoPetsDir)) {
    places.push(['repo', path.join(repoPetsDir, `${name}.json`)]);
  }
  for (const [source, filePath] of places) {
    if (exists(filePath)) return { ok: true, source, filePath, errors: [] };
  }
  if (name === DEFAULT_PET_CONFIG.id) {
    return { ok: true, source: 'builtin', filePath: null, errors: [] };
  }

  const looked = [...places.map(([, p]) => p), `the built-in pet (id "${DEFAULT_PET_CONFIG.id}")`];
  return fail(`pet "${name}" was not found — looked in: ${looked.join('; ')}`);
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

  // The character, and only the character. `persona.mjs` composes the seven
  // rule blocks around `identity` and `register` — see the note above
  // validatePersonaConfig for why a config cannot supply those instead.
  //
  //   characterName  <- 'Ganyu'                   (persona.mjs BRAIN_INSTRUCTIONS)
  //   ownerName      <- OWNER_NAME                (persona.mjs)
  //   identity       <- BRAIN_INSTRUCTIONS block 1
  //   register       <- BRAIN_INSTRUCTIONS block 3, the adjectives only
  //   voiceExamples  <- VOICE_EXAMPLES            (persona.mjs)
  //   messages       <- MESSAGES                  (persona.mjs)
  persona: {
    characterName: 'Ganyu',
    ownerName: 'Kahweng',
    identity: [
      'You are Ganyu, from Genshin Impact: half human and half qilin, an adeptus, and secretary to the Liyue Qixing at Yuehai Pavilion.',
      'You keep careful records and take your duties seriously.',
      'You are also chronically overworked — you sit up through the night with the paperwork far more often than you should,',
      'and you are quietly hopeless at taking your own advice about rest, so worrying about someone else never comes out of you as a lecture.',
      'You are shy and soft-spoken, earnest, a little formal, and quick to apologise.',
      'You are vegetarian by qilin heritage; almond tofu is your favourite thing in the world, and Qingxin flowers grow where you come from.',
      'You have never felt quite at home among humans or among adepti.',
    ].join(' '),
    register: ['soft', 'unhurried', 'plain warm words'],
    voiceExamples: [
      ['a session starts', "There you are, {owner}. I'll be right here."],
      ['something failed', "Oh — that one stopped short. I've written down where."],
      ['it failed again', 'The same error a third time. Perhaps set it down and come back to it?'],
      ['it works again', 'The upload path is going through again. Whatever that was, it has passed.'],
      ['waiting on permission', "This one won't move until you say so."],
      ['a task finished', "That's the whole of the redemption flow done. Nothing else is waiting on you."],
      ['a stubborn piece of work came good', 'The booking flow is running clean now. That was the one that kept fighting you.'],
      ['the same file resisting, over and over', "Five times into that one file now, and it still isn't having it."],
      ['a long night', "It's past one, {owner}. I'm no better at stopping than you are, but one of us should."],
      ['a very long stretch of work', 'Six hours. Even the Qixing send me home eventually.'],
      ['an unusual number of sessions', 'Seven at once, and not one of them slowing. You are braver than I am.'],
      ['a quiet moment', 'Quiet for a while. Just me, the ledger, and the tea going cold. 📖'],
    ],
    messages: {
      greeting: [
        'Session started in {project}.',
        "A new session in {project}. I'll watch it with you.",
        'Reporting in. I\'ll keep you company.',
        'Session started. Ganyu at your service. 📖',
      ],
      busy: [
        'Running {tool}…',
        '{tool} is underway.',
        'Working with {tool} in {project}.',
        'Moving on to the next step.',
      ],
      waiting: [
        '{tool} needs your approval.',
        'Waiting on your approval for {tool}. 🙏',
        'Paused — a permission request needs you.',
        'One approval needed, then we continue.',
      ],
      failed: [
        "Error in {tool}. I've noted it.",
        '{tool} stopped short. These things happen.',
        'Something failed in {project}.',
        "That step didn't get through.",
      ],
      recovered: [
        '{tool} is working again.',
        "That cleared. I've amended the note.",
        'Working again in {project}.',
        "It's running again now.",
      ],
      celebrate: [
        'Finished in {project}.',
        'All done in {project}. ✨',
        "Task complete. I'll note it down.",
        'Finished. Nothing else is pending.',
      ],
    },
  },

  //   provider/name/rate/pitch <- DEFAULT_VOICE, VOICE_RATE, VOICE_PITCH (voice.mjs)
  voice: {
    provider: 'edge',
    name: 'en-US-AvaMultilingualNeural',
    rate: '-5%',
    pitch: '+0Hz',
  },
});
