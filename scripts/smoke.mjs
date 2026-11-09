// Integrator — `npm run smoke` (contracts.md success criterion 2).
//
// Spawns `electron .` with GANYU_SMOKE=1 and asserts the main process printed
// `SMOKE_OK {json flags}` and exited 0 inside a 20s budget. The app self-quits
// after ~5s in smoke mode, so a timeout here means the window never came up.
//
// Exit 0 = smoke passed. Any failure prints the reason plus the child's output.
//
// Opt-in call-sink probe: GANYU_SMOKE_CALL="Voicemeeter AUX Input" makes the
// real renderer enumerate audio outputs and call setSinkId on the matching
// device (route mode only — the mic is never opened). Main relays its one line,
// `CALL_SINK_OK <label>` or `CALL_SINK_FAIL <reason>`; a FAIL or no line at all
// fails the smoke. Unset, nothing here changes.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TIMEOUT_MS = 20_000;
const SMOKE_RE = /^SMOKE_OK[ \t]+(\{.*\})[ \t]*$/m;
const CALL_RE = /^CALL_SINK_(OK|FAIL) .*$/m;
const SMOKE_CALL = String(process.env.GANYU_SMOKE_CALL ?? '').trim();

/** contracts.md §Window: exactly these three flags, with these values. */
const EXPECTED_FLAGS = { transparent: true, alwaysOnTop: true, frame: false };

function fail(reason, extra = '') {
  process.stderr.write(`SMOKE_FAIL ${reason}\n`);
  if (extra) process.stderr.write(`${extra}\n`);
  process.exit(1);
}

function resolveElectron() {
  const require = createRequire(import.meta.url);
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && resolved) return resolved;
    fail('the electron package did not resolve to a binary path — run `npm install`');
  } catch (err) {
    fail(`cannot resolve electron (${err?.code ?? err?.message}) — run \`npm install\``);
  }
  return null;
}

/** Electron leaves renderer/GPU children behind; kill the tree on Windows. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
    return;
  }
  child.kill('SIGKILL');
}

const electronPath = resolveElectron();
const started = Date.now();

const child = spawn(electronPath, ['.'], {
  cwd: ROOT,
  env: { ...process.env, GANYU_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  killTree(child);
}, TIMEOUT_MS);

child.on('error', (err) => {
  clearTimeout(timer);
  fail(`could not spawn electron: ${err?.message ?? err}`);
});

child.on('close', (code, signal) => {
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  const tail = `--- electron stdout ---\n${stdout}--- electron stderr ---\n${stderr}`;

  if (timedOut) fail(`no SMOKE_OK within ${TIMEOUT_MS}ms (killed after ${elapsed}ms)`, tail);

  const match = SMOKE_RE.exec(stdout);
  if (!match) fail(`electron exited (code=${code} signal=${signal}) without printing SMOKE_OK`, tail);

  let flags;
  try {
    flags = JSON.parse(match[1]);
  } catch (err) {
    fail(`SMOKE_OK payload is not JSON: ${match[1]}`, tail);
  }

  for (const [key, want] of Object.entries(EXPECTED_FLAGS)) {
    if (flags[key] !== want) fail(`flag ${key} is ${JSON.stringify(flags[key])}, expected ${want}`, tail);
  }

  if (code !== 0) fail(`SMOKE_OK printed but electron exited code=${code} signal=${signal}`, tail);

  if (SMOKE_CALL !== '') {
    const call = CALL_RE.exec(stdout);
    if (!call) fail('GANYU_SMOKE_CALL was set but the renderer printed no CALL_SINK_ line', tail);
    process.stdout.write(`${call[0].trim()}\n`);
    if (call[1] !== 'OK') fail('call sink probe failed', tail);
  }

  process.stdout.write(`${match[0].trim()}\n`);
  process.stdout.write(`smoke passed in ${elapsed}ms (electron ${path.basename(electronPath)})\n`);
  process.exit(0);
});
