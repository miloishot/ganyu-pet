/**
 * Call mode: her voice, also played into a call.
 *
 * Nothing here decides *whether* she speaks. The voice player in pet.mjs hands
 * over a clip only after it has started playing it locally, so every gate that
 * already applies — mute, bubble acceptance, salience, the throttle — applies
 * here by construction. This module only decides *where else* it goes.
 *
 * Two modes:
 *
 *   route (default) — each clip is also played on a second output device,
 *       chosen by a case-insensitive substring of its label
 *       (`GANYU_CALL_DEVICE`), via `HTMLMediaElement.setSinkId`. Mixers such as
 *       Voicemeeter or SteelSeries Sonar combine her with the mic themselves.
 *       **The mic is never opened in this mode.**
 *   mix (`GANYU_CALL_MIX_MIC=1`) — for a bare virtual cable. The owner's mic
 *       (`GANYU_CALL_MIC` substring, default input otherwise) and her clips are
 *       mixed in WebAudio and played continuously to the device. The mic is
 *       open only between a successful `start()` and the next `stop()`.
 *
 * Guarantees (pinned by test/callaudio.test.mjs):
 *   - Nothing is recorded, stored or sent. The mic stream goes from
 *     getUserMedia into an AudioContext and out to a sink; no recorder, no
 *     buffer kept, no IPC.
 *   - Every off path stops every track: stop(), a failed start, a device that
 *     disappears, and a stop() that lands while start() is still awaiting.
 *   - Failure never throws into the caller and never touches the local
 *     element. It tears call mode down and reports once through `onFail`.
 *
 * Testable without Electron: `mediaDevices`, the media-element factory and the
 * AudioContext factory are all injected.
 */

/** The canned line she says when the device cannot be used. Never the brain. */
export function callFailedLine(device) {
  const name = String(device ?? '').trim();
  return name === ''
    ? 'I cannot join the call — no call device is set.'
    : `I cannot reach the call — I could not find "${name}".`;
}

/** First device of `kind` whose label contains `needle`, case-insensitively. */
export function findDevice(devices, kind, needle) {
  const want = String(needle ?? '').trim().toLowerCase();
  if (want === '' || !Array.isArray(devices)) return null;
  return devices.find((d) => d && d.kind === kind
    && typeof d.label === 'string' && d.label.toLowerCase().includes(want)) || null;
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * `createCallAudio({mediaDevices, createAudio, createAudioContext, onFail})`
 *   -> `{start(config), stop(), play(payload), silence(), get active, get label}`
 *
 * `config` is `{device, mixMic, mic}` as main reads it from `.env.local`.
 * `start()` resolves `{ok: true, label}` or `{ok: false, reason}`; on failure it
 * has already called `onFail({device, reason})` and released everything.
 */
export function createCallAudio({
  mediaDevices = null,
  createAudio = null,
  createAudioContext = null,
  onFail = () => {},
  decode = base64ToBytes,
} = {}) {
  let gen = 0; // bumped by every stop(); a start that sees it move has been cancelled
  let active = false;
  let starting = false;
  let playSeq = 0; // the newest play() in mix mode; an older decode never starts
  let config = null;
  let sinkEl = null;
  let sinkId = null;
  let label = null;
  let stream = null;
  let ctx = null;
  let dest = null;
  let micId = null;
  let source = null; // the clip currently playing into the mix
  let onDeviceChange = null;

  function stopTracks(s) {
    if (!s || typeof s.getTracks !== 'function') return;
    for (const track of s.getTracks()) {
      try {
        track.stop();
      } catch {
        /* a track that will not stop has already ended */
      }
    }
  }

  function release() {
    if (onDeviceChange && mediaDevices?.removeEventListener) {
      try {
        mediaDevices.removeEventListener('devicechange', onDeviceChange);
      } catch { /* nothing to remove */ }
    }
    onDeviceChange = null;
    if (source) {
      try { source.stop(); } catch { /* already finished */ }
    }
    source = null;
    stopTracks(stream);
    stream = null;
    if (sinkEl) {
      try {
        sinkEl.pause?.();
        if ('srcObject' in sinkEl) sinkEl.srcObject = null;
        sinkEl.removeAttribute?.('src');
        sinkEl.load?.();
      } catch { /* an element that will not stop is not worth an exception */ }
    }
    sinkEl = null;
    if (ctx && typeof ctx.close === 'function') {
      try {
        const closing = ctx.close();
        if (closing && typeof closing.catch === 'function') closing.catch(() => {});
      } catch { /* already closed */ }
    }
    ctx = null;
    dest = null;
    sinkId = null;
    micId = null;
    label = null;
    active = false;
    starting = false;
  }

  /** Every off path. Also cancels a start() that is still awaiting. */
  function stop() {
    gen += 1;
    const was = active || sinkEl !== null || stream !== null;
    release();
    return was;
  }

  /** `device` is what the canned line names: the output, or the mic when it was the mic. */
  function fail(reason, device = config?.device ?? '') {
    stop();
    try {
      onFail({ device, reason });
    } catch { /* the caller's problem, not a reason to leave the mic open */ }
    return { ok: false, reason };
  }

  function micName() {
    return config?.mic ? config.mic : 'the default microphone';
  }

  async function listDevices() {
    const list = await mediaDevices.enumerateDevices();
    return Array.isArray(list) ? list : [];
  }

  async function start(cfg = {}) {
    stop(); // a second start replaces the first; it never stacks a second mic
    const mine = gen;
    starting = true;
    config = { device: String(cfg.device ?? '').trim(), mixMic: Boolean(cfg.mixMic), mic: String(cfg.mic ?? '').trim() };
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function' || typeof createAudio !== 'function') {
      return fail('audio devices are not available here');
    }
    if (config.device === '') return fail('GANYU_CALL_DEVICE is not set');

    let devices;
    try {
      devices = await listDevices();
    } catch (err) {
      if (mine !== gen) return { ok: false, reason: 'stopped' };
      return fail(`could not list audio devices: ${err?.message ?? err}`);
    }
    if (mine !== gen) return { ok: false, reason: 'stopped' };
    const out = findDevice(devices, 'audiooutput', config.device);
    if (!out) return fail(`no output device matches "${config.device}"`);

    const el = createAudio();
    sinkEl = el;
    try {
      if (typeof el.setSinkId !== 'function') throw new Error('setSinkId is not supported');
      await el.setSinkId(out.deviceId);
    } catch (err) {
      if (mine !== gen) return { ok: false, reason: 'stopped' };
      return fail(`could not route to "${out.label}": ${err?.message ?? err}`);
    }
    if (mine !== gen) return { ok: false, reason: 'stopped' };
    sinkId = out.deviceId;
    label = out.label;

    if (config.mixMic) {
      let mic = null;
      if (config.mic !== '') {
        mic = findDevice(devices, 'audioinput', config.mic);
        if (!mic) return fail(`no microphone matches "${config.mic}"`, micName());
      }
      if (typeof mediaDevices.getUserMedia !== 'function' || typeof createAudioContext !== 'function') {
        return fail('microphone mixing is not available here');
      }
      let got;
      try {
        got = await mediaDevices.getUserMedia({
          audio: mic ? { deviceId: { exact: mic.deviceId } } : true,
          video: false,
        });
      } catch (err) {
        if (mine !== gen) return { ok: false, reason: 'stopped' };
        return fail(`could not open the microphone: ${err?.message ?? err}`, micName());
      }
      if (mine !== gen) {
        // stop() ran while the permission prompt was up: this stream belongs to
        // a call mode that no longer exists, so it is closed before it is used.
        stopTracks(got);
        return { ok: false, reason: 'stopped' };
      }
      stream = got;
      micId = mic ? mic.deviceId : null;
      try {
        ctx = createAudioContext();
        dest = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(stream).connect(dest);
        el.srcObject = dest.stream;
        const playing = el.play?.();
        if (playing && typeof playing.catch === 'function') playing.catch(() => {});
      } catch (err) {
        return fail(`could not mix the microphone: ${err?.message ?? err}`);
      }
    }

    onDeviceChange = () => { checkDevices(); };
    mediaDevices.addEventListener?.('devicechange', onDeviceChange);
    starting = false;
    active = true;
    return { ok: true, label };
  }

  /** A device that vanishes mid-call is handled exactly like one never found. */
  async function checkDevices() {
    const mine = gen;
    if (!active) return;
    let devices;
    try {
      devices = await listDevices();
    } catch {
      return; // a failed listing is not proof the device is gone
    }
    if (mine !== gen || !active) return;
    if (!devices.some((d) => d && d.kind === 'audiooutput' && d.deviceId === sinkId)) {
      fail(`"${label}" disappeared`);
      return;
    }
    if (micId && !devices.some((d) => d && d.kind === 'audioinput' && d.deviceId === micId)) {
      fail('the microphone disappeared', micName());
    }
  }

  /** Stop the clip being said into the call, keep call mode (and the mic mix) up. */
  function silence() {
    if (!active) return false;
    playSeq += 1; // a clip still decoding is cancelled too
    if (source) {
      try { source.stop(); } catch { /* already finished */ }
      source = null;
    } else if (sinkEl && !config?.mixMic) {
      try { sinkEl.pause?.(); } catch { /* nothing playing */ }
    }
    return true;
  }

  /**
   * The same `{mime, base64}` clip the local player just started. Interrupts,
   * never queues — the same rule as the local player.
   */
  function play(payload) {
    if (!active || !sinkEl || !payload) return false;
    const { mime, base64 } = payload;
    if (typeof mime !== 'string' || typeof base64 !== 'string' || base64 === '') return false;
    if (!config.mixMic) {
      try {
        sinkEl.pause?.();
        sinkEl.src = `data:${mime};base64,${base64}`;
        const started = sinkEl.play?.();
        if (started && typeof started.catch === 'function') started.catch(() => {});
        return true;
      } catch {
        return false;
      }
    }
    const mine = gen;
    const seq = (playSeq += 1);
    let bytes;
    try {
      bytes = decode(base64);
    } catch {
      return false;
    }
    Promise.resolve()
      .then(() => ctx.decodeAudioData(bytes))
      .then((buffer) => {
        if (mine !== gen || seq !== playSeq || !ctx || !dest) return;
        if (source) {
          try { source.stop(); } catch { /* already finished */ }
        }
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(dest);
        node.start();
        source = node;
      })
      .catch(() => { /* an undecodable clip is a skipped clip, not a dead call */ });
    return true;
  }

  return {
    start,
    stop,
    play,
    silence,
    get active() { return active; },
    get starting() { return starting; },
    get label() { return label; },
    get micOpen() { return stream !== null; },
  };
}

/**
 * The smoke probe: the real operation, on the real device, in route mode only
 * (it never opens the mic). Resolves one line, `CALL_SINK_OK <label>` or
 * `CALL_SINK_FAIL <reason>`, and leaves nothing running behind it.
 */
export async function probeCallSink({ device, mediaDevices, createAudio } = {}) {
  let reason = null;
  const call = createCallAudio({ mediaDevices, createAudio, onFail: (f) => { reason = f.reason; } });
  const result = await call.start({ device, mixMic: false });
  call.stop();
  return result.ok ? `CALL_SINK_OK ${result.label}` : `CALL_SINK_FAIL ${reason ?? result.reason}`;
}
