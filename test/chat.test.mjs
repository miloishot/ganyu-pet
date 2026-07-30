// Chat module tests. No network, no Electron, no real clock: createChat takes
// the brain, the clock and the timer, so a whole conversation is drivable here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChat,
  MAX_INPUT_CHARS,
  DEFAULT_MAX_TURNS,
  REQUEST_TIMEOUT_MS,
  CHAT_CHANNELS,
} from '../src/main/chat.mjs';

/** A brain that answers via requestChat — the seam chat.mjs actually wants. */
function chatBrain(reply = 'Of course.') {
  const calls = [];
  return {
    calls,
    requestChat(args) {
      calls.push(args);
      return typeof reply === 'function' ? reply(args) : Promise.resolve(reply);
    },
  };
}

/** A brain from before requestChat existed: only the ambient status path. */
function legacyBrain(reply = 'Noted.') {
  const calls = [];
  return {
    calls,
    requestLine(args) {
      calls.push(args);
      return typeof reply === 'function' ? reply(args) : Promise.resolve(reply);
    },
  };
}

/** Hand-controlled timers, so the timeout backstop is testable in zero real ms. */
function fakeTimers() {
  const pending = [];
  return {
    pending,
    schedule: (fn, ms) => {
      pending.push({ fn, ms });
      return pending.length;
    },
    cancel: (handle) => {
      pending[handle - 1] = null;
    },
    fire: (i = 0) => {
      const t = pending[i];
      pending[i] = null;
      if (t) t.fn();
    },
  };
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ---------------------------------------------------------------------------
// constants + channels
// ---------------------------------------------------------------------------

test('chat constants and channel names follow the existing conventions', () => {
  assert.equal(MAX_INPUT_CHARS, 500);
  assert.equal(DEFAULT_MAX_TURNS, 8);
  assert.equal(REQUEST_TIMEOUT_MS, 20_000);
  assert.deepEqual(CHAT_CHANNELS, { chat: 'ganyu:chat', setFocus: 'ganyu:set-focus' });
  assert.equal(Object.isFrozen(CHAT_CHANNELS), true);
  for (const channel of Object.values(CHAT_CHANNELS)) {
    assert.match(channel, /^ganyu:[a-z-]+$/, 'same naming style as window.mjs CHANNELS');
  }
});

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('send returns the reply and records both halves of the exchange', async () => {
  const brain = chatBrain('Tea first, then the build.');
  let t = 1000;
  const chat = createChat({ brain, now: () => t });

  assert.equal(await chat.send('how are you?'), 'Tea first, then the build.');
  assert.deepEqual(chat.history(), [
    { role: 'owner', text: 'how are you?', at: 1000 },
    { role: 'ganyu', text: 'Tea first, then the build.', at: 1000 },
  ]);

  t = 2000;
  await chat.send('and now?');
  assert.deepEqual(
    chat.history().map((e) => [e.role, e.at]),
    [['owner', 1000], ['ganyu', 1000], ['owner', 2000], ['ganyu', 2000]],
  );
});

test('history() hands back copies, not the live entries', async () => {
  const chat = createChat({ brain: chatBrain('ok') });
  await chat.send('hi');
  const snapshot = chat.history();
  snapshot[0].text = 'tampered';
  snapshot.push({ role: 'owner', text: 'injected', at: 0 });
  assert.equal(chat.history()[0].text, 'hi');
  assert.equal(chat.history().length, 2);
});

test('the brain is handed the conversation *before* the new message', async () => {
  const brain = chatBrain('mm.');
  const chat = createChat({ brain, now: () => 5 });

  await chat.send('first');
  await chat.send('second');

  assert.deepEqual(brain.calls[0], { text: 'first', history: [] });
  assert.deepEqual(brain.calls[1], {
    text: 'second',
    history: [
      { role: 'owner', text: 'first', at: 5 },
      { role: 'ganyu', text: 'mm.', at: 5 },
    ],
  });
});

test('clear() empties the window', async () => {
  const chat = createChat({ brain: chatBrain('ok') });
  await chat.send('hello');
  assert.equal(chat.history().length, 2);
  chat.clear();
  assert.deepEqual(chat.history(), []);
});

// ---------------------------------------------------------------------------
// the rolling window
// ---------------------------------------------------------------------------

test('history rolls at maxTurns exchanges, dropping whole exchanges', async () => {
  const brain = chatBrain((a) => Promise.resolve(`re:${a.text}`));
  const chat = createChat({ brain, maxTurns: 3, now: () => 0 });

  for (let i = 1; i <= 5; i += 1) await chat.send(`m${i}`);

  const h = chat.history();
  assert.equal(h.length, 6, '3 exchanges x 2 entries');
  assert.deepEqual(
    h.map((e) => e.text),
    ['m3', 're:m3', 'm4', 're:m4', 'm5', 're:m5'],
  );
  // Never opens on an answer whose question has already been dropped.
  assert.equal(h[0].role, 'owner');
});

test('an unanswered message still counts as an exchange in the window', async () => {
  const brain = { requestChat: ({ text }) => Promise.resolve(text === 'b' ? null : 'ok') };
  const chat = createChat({ brain, maxTurns: 2, now: () => 0 });

  await chat.send('a');
  await chat.send('b'); // no reply
  await chat.send('c');

  assert.deepEqual(
    chat.history().map((e) => [e.role, e.text]),
    [['owner', 'b'], ['owner', 'c'], ['ganyu', 'ok']],
    'the "a" exchange rolled off; the unanswered "b" kept its slot',
  );
});

test('a nonsense maxTurns falls back to the default rather than losing history', async () => {
  for (const bad of [0, -3, NaN, undefined, 'eight']) {
    const chat = createChat({ brain: chatBrain('ok'), maxTurns: bad, now: () => 0 });
    for (let i = 0; i < DEFAULT_MAX_TURNS + 2; i += 1) await chat.send(`m${i}`);
    assert.equal(chat.history().length, DEFAULT_MAX_TURNS * 2, `maxTurns=${String(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// input handling
// ---------------------------------------------------------------------------

test('empty and whitespace-only input is ignored without touching the brain', async () => {
  const brain = chatBrain('ok');
  const chat = createChat({ brain });

  for (const input of ['', '   ', '\t\n ', null, undefined, 42, {}]) {
    assert.equal(await chat.send(input), null, `input ${JSON.stringify(input)}`);
  }
  assert.equal(brain.calls.length, 0, 'brain never called');
  assert.deepEqual(chat.history(), [], 'nothing recorded');
});

test('input is trimmed, collapsed to one line, and capped at 500 chars', async () => {
  const brain = chatBrain('ok');
  const chat = createChat({ brain, now: () => 0 });

  await chat.send('   spaced   out\n\nline   ');
  assert.equal(brain.calls[0].text, 'spaced out line', 'a pasted newline cannot smuggle in a second line');

  const paste = 'x'.repeat(MAX_INPUT_CHARS + 2000);
  await chat.send(paste);
  assert.equal(brain.calls[1].text.length, MAX_INPUT_CHARS);
  assert.equal(chat.history().at(-2).text.length, MAX_INPUT_CHARS, 'the capped text is what is remembered');
});

test('input at exactly the cap is passed through untouched', async () => {
  const brain = chatBrain('ok');
  const chat = createChat({ brain });
  const exact = 'y'.repeat(MAX_INPUT_CHARS);
  await chat.send(exact);
  assert.equal(brain.calls[0].text, exact);
});

// ---------------------------------------------------------------------------
// single-flight
// ---------------------------------------------------------------------------

test('a second send while one is in flight resolves null and never reaches the brain', async () => {
  const gate = deferred();
  const brain = chatBrain(() => gate.promise);
  const chat = createChat({ brain });

  const first = chat.send('one');
  assert.equal(chat.pending, true);
  assert.equal(await chat.send('two'), null, 'second send is refused, not queued');
  assert.equal(brain.calls.length, 1, 'brain called exactly once');

  gate.resolve('Just a moment.');
  assert.equal(await first, 'Just a moment.');
  assert.equal(chat.pending, false);

  // The latch releases: the next message goes through normally.
  assert.equal(await chat.send('three'), 'Just a moment.');
  assert.equal(brain.calls.length, 2);
  assert.deepEqual(
    chat.history().map((e) => e.text),
    ['one', 'Just a moment.', 'three', 'Just a moment.'],
    'the refused message was never recorded',
  );
});

test('the latch releases even when the brain throws', async () => {
  const brain = {
    calls: 0,
    requestChat() {
      this.calls += 1;
      throw new Error('boom');
    },
  };
  const chat = createChat({ brain });
  assert.equal(await chat.send('hi'), null);
  assert.equal(chat.pending, false);
  assert.equal(await chat.send('again'), null);
  assert.equal(brain.calls, 2, 'not wedged after a synchronous throw');
});

// ---------------------------------------------------------------------------
// failure modes — every one of them resolves null
// ---------------------------------------------------------------------------

test('every brain failure resolves null and leaves his message in the history', async () => {
  const cases = {
    rejection: () => Promise.reject(new Error('network')),
    'null reply': () => Promise.resolve(null),
    'blank reply': () => Promise.resolve('   '),
    'non-string reply': () => Promise.resolve({ text: 'nope' }),
    'undefined reply': () => Promise.resolve(undefined),
  };

  for (const [label, reply] of Object.entries(cases)) {
    const chat = createChat({ brain: chatBrain(reply), now: () => 7 });
    assert.equal(await chat.send('are you there?'), null, label);
    assert.deepEqual(
      chat.history(),
      [{ role: 'owner', text: 'are you there?', at: 7 }],
      `${label}: his line survives, no ganyu entry`,
    );
  }
});

test('no brain at all resolves null instead of throwing', async () => {
  for (const brain of [null, undefined, {}, { requestLine: 'not a function' }]) {
    const chat = createChat({ brain });
    assert.equal(await chat.send('hello?'), null);
    assert.equal(chat.history().length, 1, 'he still said it');
  }
});

test('a brain that never settles times out to null instead of hanging', async () => {
  const timers = fakeTimers();
  const brain = chatBrain(() => new Promise(() => {})); // never resolves
  const chat = createChat({
    brain,
    timeoutMs: 20_000,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  const pending = chat.send('anyone home?');
  assert.equal(timers.pending[0].ms, 20_000);
  timers.fire(0);

  assert.equal(await pending, null);
  assert.equal(chat.pending, false, 'the latch is released, so the next message works');
});

test('a reply that arrives in time cancels the timeout guard', async () => {
  const timers = fakeTimers();
  const chat = createChat({
    brain: chatBrain('Here.'),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  assert.equal(await chat.send('hi'), 'Here.');
  assert.deepEqual(timers.pending, [null], 'guard cancelled, no dangling timer');
});

// ---------------------------------------------------------------------------
// brain seam: requestChat preferred, requestLine the fallback
// ---------------------------------------------------------------------------

test('requestChat is preferred whenever the brain has one', async () => {
  const both = {
    chatCalls: [],
    lineCalls: [],
    requestChat(a) {
      this.chatCalls.push(a);
      return Promise.resolve('chat reply');
    },
    requestLine(a) {
      this.lineCalls.push(a);
      return Promise.resolve('status line');
    },
  };
  const chat = createChat({ brain: both, now: () => 0 });

  assert.equal(await chat.send('what are you doing?'), 'chat reply');
  assert.equal(both.lineCalls.length, 0, 'the status path is not used for chat');
  assert.deepEqual(both.chatCalls, [{ text: 'what are you doing?', history: [] }]);
});

test('requestLine is the fallback, and is told it is being spoken to', async () => {
  const brain = legacyBrain('Noted, thank you.');
  const chat = createChat({ brain, now: () => 3 });

  await chat.send('good morning');
  await chat.send('busy?');

  assert.equal(brain.calls.length, 2);
  const [first, second] = brain.calls;
  assert.equal(first.detail.kind, 'chat', 'flagged as chat, not a hook event');
  assert.equal(first.detail.text, 'good morning');
  assert.deepEqual(first.detail.history, []);
  assert.match(first.summary, /good morning/, 'the summary carries what he actually said');
  assert.match(first.summary, /speaking to you directly/);
  assert.deepEqual(second.detail.history, [
    { role: 'owner', text: 'good morning', at: 3 },
    { role: 'ganyu', text: 'Noted, thank you.', at: 3 },
  ]);
});

test('the requestLine fallback still resolves null on failure', async () => {
  const chat = createChat({ brain: legacyBrain(() => Promise.resolve(null)) });
  assert.equal(await chat.send('hello'), null);
});
