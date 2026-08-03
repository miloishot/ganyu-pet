<h1 align="center">ganyu-pet</h1>

<p align="center">
  A desktop companion that watches your coding agent work — and has opinions about it.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/Node-22+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/Windows_11-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows 11">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT">
</p>

<!-- DEMO GIF GOES HERE. Record one, save it to docs/demo.gif, then uncomment:
<p align="center">
  <img src="docs/demo.gif" alt="Ganyu reacting to a failing test" width="480">
</p>
-->

---

A small always-on-top overlay sits on your desktop. It listens to **Codex** and **Claude Code**
lifecycle hooks over localhost, so it knows when a session starts, when a tool is approved, when
a test fails, and when you have been at it since before midnight. Most of the time it says
nothing. When something actually happens, it says one line about it — and you can click it and
type back.

It is not a status bar with a face. The design constraint throughout was that it should be
**quiet by default**, and never worse than saying nothing at all.

### What it does

- **Reacts to real events.** A localhost HTTP endpoint receives hook payloads and normalises them
  into a state machine — idle, busy, failed, celebrating. The sprite animates accordingly.
- **Speaks only when it matters.** A salience gate passes failures, recoveries, approvals and
  session boundaries. Routine `Read`/`Grep` chatter is dropped, with a 90-second quiet throttle
  on top. Five routine events in a row produce no bubble at all.
- **Remembers.** A ledger on disk survives restarts, so "what was I doing yesterday" has an
  answer that is not invented.
- **Talks back.** Left-click opens an input strip inside the existing overlay — no resize, no
  focus stolen from your editor. Eight-turn rolling context.
- **Listens**, optionally, via push-to-talk against any Whisper-compatible endpoint.
- **Wanders** when idle, and gets out of the way when you drag it.

### Bring your own pet

**No character art ships with this repo.** The overlay reads spritesheets that
[Codex](https://github.com/openai/codex) already installed on your machine, at
`~/.codex/pets/<pet-id>/`. Ganyu is the reference pet because that is the one on the author's
disk — any sheet in that folder works.

Adding a new one is a measured process rather than a guess, because the upstream `pet.json`
format records no grid, no frame size, and no hint of what any row depicts:

```bash
npx electron scripts/analyze-pet.mjs <pet-id> --out pet-config.json
```

That measures the sheet and writes a draft config with correct geometry and placeholder
semantics. You finish it by looking at the image. The five steps, the field reference, and three
traps that will otherwise cost you an evening are in **[`docs/pet-config.md`](docs/pet-config.md)**.

### Setup

Requires **Node 22+** and Windows 11.

```bash
git clone https://github.com/miloishot/ganyu-pet.git
cd ganyu-pet
npm install
npm start
```

That runs it with no brain — it animates, reacts and wanders, and nothing leaves your machine.

**To let it speak**, copy `.env.local.example` to `.env.local` and add an OpenAI-compatible
endpoint and key. The file documents every switch, including the three that govern what it is
allowed to see. All three default **on**, and all three only matter once a key is set.

**To wire up the hooks**, the installer is append-only — it never removes, reorders or rewrites
existing entries, and it backs up before writing:

```bash
node hooks/install-hooks.mjs            # dry run, prints a diff
node hooks/install-hooks.mjs --apply
```

### Privacy

Everything is local except calls to the endpoint you configure. There is no telemetry and no
server. Session-transcript reading goes through an allowlist that passes assistant prose, your
own asks, the session title, and failure sentences derived from the prose — **never** a tool
input, tool result, thinking block, attachment, or file-history record.

If you would rather it saw less, `GANYU_SEE_PROMPTS=0` and `GANYU_READ_SESSIONS=0` in
`.env.local`.

### Development

```bash
npm test      # node --test, no framework
npm run smoke # end-to-end: boots the window, fires synthetic events
```

The full spec — HTTP contract, IPC surface, state machine, window geometry, and the reasoning
behind each — is in **[`contracts.md`](contracts.md)**. It is written to be read before the code.

### License

MIT — see [`LICENSE`](LICENSE). Character artwork is not covered by it and is not distributed
here; sprites come from your own Codex pet installs.
