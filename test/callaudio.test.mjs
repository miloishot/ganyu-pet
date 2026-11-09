// Call mode (src/renderer/callaudio.mjs), driven with injected fakes — no
// Electron, no real devices, no real mic.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCallAudio, findDevice, callFailedLine, probeCallSink } from '../src/renderer/callaudio.mjs';

const MP3 = { mime: 'audio/mpeg', base64: 'QUJD' };

const DEVICES = [
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers (Realtek)' },
  { kind: 'audiooutput', deviceId: 'vm-in', label: 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)' },
  { kind: 'audiooutput', deviceId: 'vm-aux', label: 'Voicemeeter AUX Input (VB-Audio Voicemeeter AUX VAIO)' },
  { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone (USB Mic)' },
  { kind: 'audioinput', deviceId: 'cable-out', label: 'CABLE Output (VB-Audio Virtual Cable)' },
];

/** Every media API the module touches, recording what was asked of it. */
function makeMedia({ devices = DEVICES, sinkRejects = false, gumRejects = false } = {}) {
  const kit = {
    devices: devices.slice(),
    sinkRejects,
    gumRejects,
    gum: [],
    tracks: [],
    els: [],
    ctxs: [],
    sources: [],
    listeners: new Set(),
    fails: [],
  };
  kit.mediaDevices = {
    enumerateDevices: async () => kit.devices.slice(),
    getUserMedia: async (constraints) => {
      kit.gum.push(constraints);
      if (kit.gumRejects) throw new Error('NotAllowedError');
      const track = { stopped: false, stop() { track.stopped = true; } };
      kit.tracks.push(track);
      return { getTracks: () => [track] };
    },
    addEventListener: (type, fn) => { if (type === 'devicechange') kit.listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'devicechange') kit.listeners.delete(fn); },
  };
  kit.createAudio = () => {
    const el = {
      sinkId: '',
      src: '',
      srcObject: null,
      played: [],
      paused: 0,
      async setSinkId(id) {
        if (kit.sinkRejects) throw new Error('NotFoundError: Requested device not found');
        el.sinkId = id;
      },
      play() { el.played.push(el.srcObject ? 'stream' : el.src); return Promise.resolve(); },
      pause() { el.paused += 1; },
      load() {},
      removeAttribute(name) { if (name === 'src') el.src = ''; },
    };
    kit.els.push(el);
    return el;
  };
  kit.createAudioContext = () => {
    const ctx = {
      closed: false,
      connected: [],
      close() { ctx.closed = true; return Promise.resolve(); },
      createMediaStreamDestination: () => ({ stream: { id: 'mix' } }),
      createMediaStreamSource: (s) => ({ connect: (d) => ctx.connected.push({ from: s, to: d }) }),
      decodeAudioData: async () => ({ duration: 1 }),
      createBufferSource: () => {
        const node = { started: false, stopped: false, connect() {}, start() { node.started = true; }, stop() { node.stopped = true; } };
        kit.sources.push(node);
        return node;
      },
    };
    kit.ctxs.push(ctx);
    return ctx;
  };
  kit.call = () => createCallAudio({
    mediaDevices: kit.mediaDevices,
    createAudio: kit.createAudio,
    createAudioContext: kit.createAudioContext,
    onFail: (f) => kit.fails.push(f),
    decode: () => new ArrayBuffer(3),
  });
  kit.fireChange = async () => {
    for (const fn of [...kit.listeners]) fn();
    await flush();
  };
  return kit;
}

const flush = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ matching

test('device matching is a case-insensitive substring of the label, by kind', () => {
  assert.equal(findDevice(DEVICES, 'audiooutput', 'voicemeeter aux input').deviceId, 'vm-aux');
  assert.equal(findDevice(DEVICES, 'audiooutput', 'VOICEMEETER AUX').deviceId, 'vm-aux');
  assert.equal(findDevice(DEVICES, 'audiooutput', 'Voicemeeter Input').deviceId, 'vm-in');
  // An input device never satisfies an output search, even when the label matches.
  assert.equal(findDevice(DEVICES, 'audiooutput', 'CABLE Output'), null);
  assert.equal(findDevice(DEVICES, 'audioinput', 'cable output').deviceId, 'cable-out');
  assert.equal(findDevice(DEVICES, 'audiooutput', ''), null, 'blank matches nothing, not the first device');
  assert.equal(findDevice(null, 'audiooutput', 'x'), null);
});

test('the canned failure line names the device, and is plain text', () => {
  assert.match(callFailedLine('Voicemeeter AUX Input'), /Voicemeeter AUX Input/);
  assert.ok(callFailedLine('').length > 0);
});

// ------------------------------------------------------------------ route mode

test('route mode: a clip goes to the sink whose label matches, and the mic is never opened', async () => {
  const kit = makeMedia();
  const call = kit.call();
  const started = await call.start({ device: 'voicemeeter aux INPUT' });
  assert.deepEqual(started, { ok: true, label: DEVICES[2].label });
  assert.equal(call.active, true);
  assert.equal(kit.els.length, 1, 'one call element, separate from the local one');
  assert.equal(kit.els[0].sinkId, 'vm-aux');

  assert.equal(call.play(MP3), true);
  assert.deepEqual(kit.els[0].played, ['data:audio/mpeg;base64,QUJD']);

  assert.equal(kit.gum.length, 0, 'route mode never calls getUserMedia');
  assert.equal(kit.ctxs.length, 0, 'and builds no mixer');
  call.stop();
  assert.equal(call.active, false);
  assert.equal(call.play(MP3), false, 'nothing plays into a call that is off');
});

test('no matching device: call mode goes off with one failure, nothing left running', async () => {
  const kit = makeMedia();
  const call = kit.call();
  const result = await call.start({ device: 'CABLE Input' });
  assert.equal(result.ok, false);
  assert.equal(call.active, false);
  assert.equal(kit.fails.length, 1);
  assert.equal(kit.fails[0].device, 'CABLE Input');
  assert.equal(kit.els.length, 0, 'no element was even created');
  assert.equal(kit.gum.length, 0);
});

test('setSinkId rejects: call mode goes off with one failure', async () => {
  const kit = makeMedia({ sinkRejects: true });
  const call = kit.call();
  const result = await call.start({ device: 'Voicemeeter AUX Input', mixMic: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /NotFoundError/);
  assert.equal(call.active, false);
  assert.equal(kit.fails.length, 1);
  assert.equal(kit.gum.length, 0, 'the mic is not opened for a sink that failed');
});

test('a blank device is a failure, not the first device', async () => {
  const kit = makeMedia();
  const call = kit.call();
  assert.equal((await call.start({ device: '' })).ok, false);
  assert.equal(kit.fails.length, 1);
  assert.equal(kit.els.length, 0);
});

test('the sink vanishing mid-call is handled exactly like one never found', async () => {
  const kit = makeMedia();
  const call = kit.call();
  await call.start({ device: 'Voicemeeter AUX Input' });
  assert.equal(kit.listeners.size, 1, 'watching devicechange while active');

  // A change that keeps the sink is not a failure.
  kit.devices.push({ kind: 'audiooutput', deviceId: 'hdmi', label: 'HDMI' });
  await kit.fireChange();
  assert.equal(call.active, true);
  assert.equal(kit.fails.length, 0);

  kit.devices = kit.devices.filter((d) => d.deviceId !== 'vm-aux');
  await kit.fireChange();
  assert.equal(call.active, false);
  assert.equal(kit.fails.length, 1);
  assert.match(kit.fails[0].reason, /disappeared/);
  assert.equal(kit.listeners.size, 0, 'the listener goes with the call');
});

// ------------------------------------------------------------------ mix mode

test('mix mode: the mic opens audio-only, is mixed, and clips join the mix', async () => {
  const kit = makeMedia();
  const call = kit.call();
  const result = await call.start({ device: 'Voicemeeter Input', mixMic: true, mic: 'usb mic' });
  assert.equal(result.ok, true);
  assert.deepEqual(kit.gum, [{ audio: { deviceId: { exact: 'mic-1' } }, video: false }]);
  assert.equal(call.micOpen, true);
  assert.deepEqual(kit.els[0].srcObject, { id: 'mix' }, 'the mix plays continuously to the sink');
  assert.equal(kit.ctxs[0].connected.length, 1, 'mic into the mix');

  assert.equal(call.play(MP3), true);
  await flush();
  assert.equal(kit.sources.length, 1);
  assert.equal(kit.sources[0].started, true);
  call.play(MP3);
  await flush();
  assert.equal(kit.sources[0].stopped, true, 'a new clip interrupts, never queues');
  call.stop();
});

test('mix mode with no mic set uses the default input', async () => {
  const kit = makeMedia();
  const call = kit.call();
  await call.start({ device: 'Voicemeeter Input', mixMic: true });
  assert.deepEqual(kit.gum, [{ audio: true, video: false }]);
  call.stop();
  assert.equal(kit.tracks[0].stopped, true);
});

test('every off path stops every mic track: toggle, error, device loss, cancelled start', async () => {
  // toggle-off
  let kit = makeMedia();
  let call = kit.call();
  await call.start({ device: 'Voicemeeter Input', mixMic: true });
  call.stop();
  assert.ok(kit.tracks.every((t) => t.stopped), 'toggle-off');
  assert.equal(kit.ctxs[0].closed, true);
  assert.equal(call.micOpen, false);

  // error after the mic opened: the mic device itself vanishes
  kit = makeMedia();
  call = kit.call();
  await call.start({ device: 'Voicemeeter Input', mixMic: true, mic: 'USB Mic' });
  kit.devices = kit.devices.filter((d) => d.deviceId !== 'mic-1');
  await kit.fireChange();
  assert.equal(call.active, false);
  assert.ok(kit.tracks.every((t) => t.stopped), 'device loss');
  assert.equal(kit.fails.length, 1);

  // error: the mic setting matches nothing — the mic is never opened at all
  kit = makeMedia();
  call = kit.call();
  assert.equal((await call.start({ device: 'Voicemeeter Input', mixMic: true, mic: 'no such mic' })).ok, false);
  assert.equal(kit.gum.length, 0);

  // error: getUserMedia refuses
  kit = makeMedia({ gumRejects: true });
  call = kit.call();
  assert.equal((await call.start({ device: 'Voicemeeter Input', mixMic: true })).ok, false);
  assert.equal(call.active, false);
  assert.equal(kit.fails.length, 1);

  // stop() lands while getUserMedia is still pending: the late stream is closed
  kit = makeMedia();
  let release;
  const gate = new Promise((r) => { release = r; });
  const realGum = kit.mediaDevices.getUserMedia;
  kit.mediaDevices.getUserMedia = async (c) => { await gate; return realGum(c); };
  call = kit.call();
  const starting = call.start({ device: 'Voicemeeter Input', mixMic: true });
  await flush();
  call.stop();
  release();
  const late = await starting;
  assert.equal(late.ok, false);
  assert.equal(kit.tracks.length, 1);
  assert.equal(kit.tracks[0].stopped, true, 'a stream that arrives after stop() is stopped');
  assert.equal(call.active, false);
  assert.equal(call.micOpen, false);
  assert.equal(kit.fails.length, 0, 'a cancelled start is not a failure');
});

test('silence() stops the clip mid-sentence but keeps the call up', async () => {
  const kit = makeMedia();
  const call = kit.call();
  await call.start({ device: 'Voicemeeter AUX Input' });
  call.play(MP3);
  assert.equal(call.silence(), true);
  assert.ok(kit.els[0].paused >= 1);
  assert.equal(call.active, true);
  call.stop();
});

test('nothing is recorded or kept: no MediaRecorder exists in the module', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/renderer/callaudio.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /MediaRecorder|localStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket/);
});

// ------------------------------------------------------------------ smoke probe

test('the smoke probe performs setSinkId and reports one line, mic untouched', async () => {
  const kit = makeMedia();
  const ok = await probeCallSink({ device: 'Voicemeeter AUX Input', mediaDevices: kit.mediaDevices, createAudio: kit.createAudio });
  assert.equal(ok, `CALL_SINK_OK ${DEVICES[2].label}`);
  assert.equal(kit.els[0].sinkId, 'vm-aux');
  assert.equal(kit.gum.length, 0);
  assert.equal(kit.listeners.size, 0, 'nothing left watching');

  const bad = await probeCallSink({ device: 'CABLE Input', mediaDevices: kit.mediaDevices, createAudio: kit.createAudio });
  assert.match(bad, /^CALL_SINK_FAIL no output device matches "CABLE Input"$/);
});

test('mix mode: a clip still decoding never starts after silence() or a newer clip', async () => {
  const kit = makeMedia();
  const call = kit.call();
  await call.start({ device: 'Voicemeeter Input', mixMic: true });
  const pending = [];
  kit.ctxs[0].decodeAudioData = () => new Promise((r) => pending.push(r));

  call.play(MP3);
  await flush();
  call.silence(); // muted while the first clip was decoding
  pending[0]({});
  await flush();
  assert.equal(kit.sources.length, 0, 'a clip decoded after mute is never started');

  call.play(MP3);
  call.play(MP3);
  await flush();
  pending[2]({}); // the newer one finishes first
  await flush();
  pending[1]({}); // then the older one
  await flush();
  assert.equal(kit.sources.length, 1, 'only the newest clip plays');
  call.stop();
});

test('a mic failure names the mic, not the output', async () => {
  let kit = makeMedia();
  await kit.call().start({ device: 'Voicemeeter Input', mixMic: true, mic: 'Blue Yeti' });
  assert.equal(kit.fails[0].device, 'Blue Yeti');

  kit = makeMedia({ gumRejects: true });
  await kit.call().start({ device: 'Voicemeeter Input', mixMic: true });
  assert.equal(kit.fails[0].device, 'the default microphone');
});

test('starting is true only while start() is awaiting', async () => {
  const kit = makeMedia();
  const call = kit.call();
  assert.equal(call.starting, false);
  const p = call.start({ device: 'Voicemeeter AUX Input' });
  assert.equal(call.starting, true);
  await p;
  assert.equal(call.starting, false);
  assert.equal(call.active, true);
  call.stop();
  assert.equal(call.starting, false);
});

test('a named device that is also the Windows default resolves to the real device, not the alias', () => {
  const list = [
    { kind: 'audiooutput', deviceId: 'default', label: 'Default - Voicemeeter Input (VB-Audio Voicemeeter VAIO)' },
    { kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Voicemeeter Input (VB-Audio Voicemeeter VAIO)' },
    { kind: 'audiooutput', deviceId: 'vm-in', label: 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)' },
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Microphone (USB Mic)' },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone (USB Mic)' },
  ];
  assert.equal(findDevice(list, 'audiooutput', 'voicemeeter input').deviceId, 'vm-in');
  assert.equal(findDevice(list, 'audioinput', 'usb mic').deviceId, 'mic-1');
  assert.equal(findDevice(list.slice(0, 2), 'audiooutput', 'voicemeeter input'), null, 'an alias alone is not a match');
});
