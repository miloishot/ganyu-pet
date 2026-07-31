# Adding a new pet

Start here:

```
npx electron scripts/analyze-pet.mjs <pet-id> --out pet-config.json
```

`<pet-id>` is the folder name under `~/.codex/pets/` (or `$CODEX_HOME/pets/`). You can also
pass a directory or a path straight to an image.

That measures the spritesheet and writes a draft config. The draft's **geometry is correct
and its semantics are placeholders** — you finish it by looking at the sheet. The five steps
are below.

---

## Why any of this is necessary

Codex installs a pet as two files:

```
~/.codex/pets/ganyu--chenxin-dlut/
  pet.json
  spritesheet.webp
```

and `pet.json` says only this:

```json
{
  "id": "ganyu--chenxin-dlut",
  "displayName": "Ganyu",
  "description": "A chibi Codex digital pet version of Ganyu herself.",
  "spritesheetPath": "spritesheet.webp",
  "kind": "character"
}
```

**That is the whole upstream format.** No grid. No frame size. No frame counts. No hint of
what any row depicts. Every number the renderer needs — 8 columns, 9 rows, 192×208 cells,
and the fact that row 3 holds only 4 real frames — had to be measured off the image, and
every row's *meaning* had to be looked at by a person.

So a new pet needs two things this repo can supply: a measurement (the analyzer) and a
written-down answer to "which row is which" (the config). That is what
`src/main/petconfig.mjs` is.

---

## The five steps

### 1. Measure the sheet

```
npx electron scripts/analyze-pet.mjs <pet-id>
```

Add `--out <path>` to write the draft as well as print it. It prints:

```
spritesheet  C:\Users\kw11l\.codex\pets\ganyu--chenxin-dlut\spritesheet.webp
             2,121,564 bytes, alpha threshold 16
sheet        1536 x 1872
grid         8 columns x 9 rows of 192x208  (columns inferred, 100% of boundaries fall in
             empty space; rows inferred, 100%)

opaque % per cell — a blank cell reads 0.0, a real frame roughly 35-50
  row     c0     c1     c2     c3     c4     c5     c6     c7   frames
    0   37.5   37.1   37.6   37.3   37.1   37.4    0.0    0.0        6
    1   36.8   35.8   37.8   38.4   38.6   36.7   37.5   36.4        8
    2   38.4   36.4   35.0   35.6   37.0   35.0   35.3   38.1        8
    3   39.8   38.8   41.0   40.0    0.0    0.0    0.0    0.0        4
    4   50.4   46.4   49.0   43.2   47.3    0.0    0.0    0.0        5
    5   37.0   39.7   47.0   66.9   52.0   40.4   36.4   36.6        8
    6   37.6   36.3   36.0   36.0   34.5   37.0    0.0    0.0        6
    7   36.3   36.1   35.6   35.8   36.0   35.8    0.0    0.0        6
    8   44.5   43.6   44.6   44.5   41.7   45.0    0.0    0.0        6

frames per row  [6, 8, 8, 4, 5, 8, 6, 6, 6]
```

**The table is the point.** The `0.0` cells are genuinely empty image — that is how the
analyzer knows row 3 has 4 frames and not 8. The percentages also tell you something about
the poses before you have looked at one: row 4 is the widest-spread row on the sheet (43–50%
against everyone else's ~36%), which is what a jump looks like when the character's limbs
are out.

If the grid comes out wrong, pass `--cols` / `--rows` and it will use yours instead. See
*How the grid is guessed* below for when that happens.

### 2. Look at the sheet and name the rows

Open the `.webp` in anything that renders it and read it left-to-right, top-to-bottom. You
are answering one question per row: **what is this character doing?**

Write the answer into each row's `label`, replacing `"TODO row N"`. The labels are for you
and for whoever reads this config in a year; nothing depends on their exact spelling.

Watch for two things specifically — both are covered under *Traps*:

- a row where the character **runs without going anywhere**;
- a row that is a *stance* (standing, thinking) rather than a *motion*.

### 3. Point the modes at rows

```json
"modes":     { "idle": 0, "busy": 8, "waiting": 6, "failed": 5 },
"walk":      { "right": 1, "left": 2 },
"airborne":  4,
"celebrate": [4, 3]
```

- **`modes`** — all four aggregate modes from the state machine. All four are required: an
  unmapped mode falls back to idle, so the pet would just stand there through an entire
  failure.
- **`walk`** — the two run cycles. `walk` outranks `modes`, so these play whenever she is
  actually strolling, regardless of what the machine is doing.
- **`airborne`** — held in the cursor or mid-throw. Outranks both. Whatever the machine is
  doing, she is plainly not standing on anything, so this wants the one pose on the sheet
  that is not a stance.
- **`celebrate`** — a one-shot sequence played on the rising edge of a finished task, then
  back to the base row. `[]` is fine if the sheet has no celebration pose.

Any row you deliberately leave unreachable gets an `unmappedReason` instead — see *Traps*.

### 4. Write the persona

Optional, and separate from the animation. `validatePersonaConfig` in
`src/main/petconfig.mjs` defines the shape:

```json
"persona": {
  "characterName": "…",
  "ownerName": "…",
  "instructions": "…",
  "voiceExamples": [["a session starts", "…"], ["something failed", "…"]],
  "messages": {
    "greeting": ["…"], "busy": ["…"], "waiting": ["…"],
    "failed": ["…"], "recovered": ["…"], "celebrate": ["…"]
  }
}
```

**`voiceExamples` cannot be empty, and that is enforced.** Instructions alone reliably
produce a generic corporate assistant no matter how the character is described in the
abstract — the labelled examples are what actually move the register. `persona.mjs` records
what that failure looked like in practice, at length, and it is worth reading before writing
a new one.

`messages` is the canned fallback used whenever the LLM is unavailable, so every kind needs
at least one line.

> Ganyu's own persona text still lives in `src/main/persona.mjs`, not in a config file. The
> schema here defines the shape a *new* pet's persona would travel in.

### 5. Validate it

```js
import { loadPetConfig } from './src/main/petconfig.mjs';
import fs from 'node:fs';

const result = loadPetConfig({ fs, filePath: 'pet-config.json' });
if (!result.ok) console.error(result.errors.join('\n'));
```

`loadPetConfig` never throws — a missing file, a corrupt one and a wrong one all come back
as `{ok: false, errors}`. The messages are meant to be actionable on their own:

```
animation.rows[3].frames: 9 frames on a 8-column sheet — a row cannot hold more
  frames than the grid is wide
animation.modes.busy: row 12 does not exist on a 9-row sheet (valid rows are 0-8)
animation.rows[7]: marked unmapped ("A run-in-place animation…") but mode "busy"
  maps to it — a row is either deliberately unreachable or it is used, not both
```

---

## The worked example: Ganyu

This is `DEFAULT_PET_CONFIG` in `src/main/petconfig.mjs` — the pet that actually ships,
written out in full. Every number is a transcription of a constant that already exists in
`src/renderer/pet.mjs` or `src/main/window.mjs`, so it is the answer sheet for the format.

```jsonc
{
  "schemaVersion": 1,
  "id": "ganyu--chenxin-dlut",
  "displayName": "Ganyu",
  "spritesheet": "spritesheet.webp",   // relative to this file, or absolute

  "geometry": { "frameW": 192, "frameH": 208, "columns": 8, "rows": 9 },

  "animation": {
    "defaultFps": 8,

    // One entry per physical row, in sheet order. `frames` is the count of REAL
    // frames — the grid is 8 wide but only rows 1, 2 and 5 fill it.
    "rows": [
      { "label": "idle",      "frames": 6 },
      { "label": "run-right", "frames": 8, "fps": 6 },
      { "label": "run-left",  "frames": 8, "fps": 6 },
      { "label": "wave",      "frames": 4 },
      { "label": "jump",      "frames": 5 },
      { "label": "failed",    "frames": 8 },
      { "label": "waiting",   "frames": 6 },
      { "label": "busy-run-in-place", "frames": 6,
        "unmappedReason": "A run-in-place animation. Played while the pet is stationary it reads as jogging on the spot, so busy draws the standing review pose (row 8) instead; real locomotion already draws rows 1/2 through walk." },
      { "label": "review",    "frames": 6 }
    ],

    "modes":     { "idle": 0, "busy": 8, "waiting": 6, "failed": 5 },
    "walk":      { "right": 1, "left": 2 },
    "airborne":  4,
    "celebrate": [4, 3]
  },

  "presentation": { "windowWidth": 256, "windowHeight": 320 }
}
```

Note two things about that map. `busy` points at row **8**, not the row labelled busy — see
the second trap. And row 4 (jump) does double duty as both the `airborne` pose and the first
beat of the celebrate pulse, which is fine: a row may be pointed at from more than one place.

---

## Traps

These are the three that actually cost time on this sheet.

### 1. Trailing cells are transparent, and animating into them blinks the pet out

The grid is 8 columns wide. Six of the nine rows stop short, and their remaining cells are
**fully transparent image**, not missing data. Looping every row to 8 draws blank frames:
idle at 8 fps lost 250ms of every second, which reads as the pet flickering rather than as
an animation bug.

So `frames` is per row and the animation wraps there, never at `columns`. The validator
rejects a count larger than the grid is wide, and the analyzer measures the count rather than
assuming it.

### 2. A run-in-place row is not an idle or busy pose

Ganyu's row 7 is a running animation that does not travel. It is the obvious candidate for
"busy" — it is even what the row looks like it is for — and it is wrong: played while the
pet is standing still, it reads as jogging on the spot. Stationary `busy` draws **row 8**
instead, a standing thinking pose. Real locomotion already has rows 1 and 2, which `walk`
selects and which outrank the mode anyway.

Row 7 therefore stays on the sheet and in the config, reachable from nothing:

```json
{ "label": "busy-run-in-place", "frames": 6,
  "unmappedReason": "A run-in-place animation. Played while the pet is stationary it reads as jogging on the spot…" }
```

**`unmappedReason` is load-bearing, not a comment.** It is the difference between a
deliberate decision and an oversight, and without it the next person to read the config
"fixes" the gap by pointing `busy` at row 7 again. The validator enforces the other half:
a row carrying an `unmappedReason` that something *does* map to is an error, and the message
names what maps to it.

### 3. `pet.json` tells you none of this

Worth repeating because it is the reason the analyzer exists. Upstream's metadata has an id,
a name, a description, a path and a "kind". It does not have the grid, the frame size, the
frame counts, or the row semantics — and it never will, because those are properties of the
image rather than of the installation. Do not go looking for a field that carries them.

---

## How the grid is guessed

The analyzer does not know the frame size, so it derives it: a real cell boundary falls in
the gap *between* two sprites, so the pixel columns either side of it are entirely
transparent. Each candidate grid is scored by the fraction of its interior boundaries that
land in such a gap, and the answer is the **finest** grid that scores above 80%.

Finest matters, because score alone is not enough — every coarser grid whose boundaries are a
subset of the true ones scores just as well. On the Ganyu sheet, 4 columns of 384px aligns
perfectly and is simply wrong. 8 columns of 192px scores 7/7; 16 columns of 96px puts a
boundary through the middle of every sprite and scores 7/15, so it is rejected.

This fails when the sprites touch their cell edges, leaving no gap to find. The symptom is an
implausibly coarse grid — often `1x1` — and the analyzer warns when it returns one. The fix
is to pass the real numbers:

```
npx electron scripts/analyze-pet.mjs <pet-id> --cols 8 --rows 9
```

Other options:

| Option | Effect |
|---|---|
| `--cols N`, `--rows N` | override the inferred grid. Must divide the sheet evenly. |
| `--alpha N` | opacity threshold, 0–255, default 16. Raise it if a sheet's "empty" cells carry faint noise. |
| `--out FILE` | write the draft JSON as well as printing it. |

The analyzer reads the image and writes nothing unless `--out` is given. It exits non-zero
with a message if the pet cannot be found, the image cannot be decoded, or an override does
not divide the sheet.

One detail about `--out`: the draft's `spritesheet` is written **relative** when the config
lands in the same directory as the image (the recommended layout, and the one upstream uses),
and **absolute** otherwise. A seven-level `../../..` chain resolves today and breaks the
moment either file moves.

---

## Field reference

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | Must match `PET_SCHEMA_VERSION`. A mismatch is rejected outright rather than partially understood. |
| `id` | string | The Codex pet id. |
| `displayName` | string | Shown to humans. |
| `spritesheet` | string | Absolute, or relative to the config file. |
| `geometry.frameW` / `frameH` | int > 0 | One cell, in pixels. |
| `geometry.columns` / `rows` | int > 0 | The grid. `frameW × columns` is the sheet width; the sheet's own dimensions are deliberately not stored, since a fifth number that must agree with four others will one day disagree. |
| `animation.defaultFps` | number > 0 | Frame rate for any row without its own. |
| `animation.rows[]` | array | Exactly one entry per row, in sheet order. |
| `animation.rows[].frames` | int 0…`columns` | Real (non-transparent) frames. `0` is allowed only with an `unmappedReason`. |
| `animation.rows[].fps` | number > 0 | Optional per-row override. |
| `animation.rows[].label` | string | Optional. For humans. |
| `animation.rows[].unmappedReason` | string | Optional. Declares the row deliberately unreachable — and it is an error for anything to map to it. |
| `animation.modes` | `{idle, busy, waiting, failed}` | All four required. |
| `animation.walk` | `{left, right}` | Both required. Outranks `modes`. |
| `animation.airborne` | row index | Required. Outranks everything. |
| `animation.celebrate` | row index[] | May be `[]`. |
| `presentation.windowWidth` / `windowHeight` | int > 0 | Must be at least the frame size, or the sprite is cropped. Ganyu's 256×320 is a 192×208 frame plus bubble headroom. |
| `persona` | object | Optional. See step 4. |

Unknown keys are **rejected**, not ignored. A mistyped `"fsp": 6` on a walk row would
otherwise animate at the default rate forever and look like a problem with the sheet.
