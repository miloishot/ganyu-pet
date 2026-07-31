// Module C — speech bubble. Newest line replaces the current one; each line
// lives BUBBLE_TTL_MS then fades out (opacity transition lives in styles.css).
// Timers are injected so this file is testable without a DOM or a real clock.

export const BUBBLE_TTL_MS = 8000;
export const BUBBLE_FADE_MS = 400; // must be >= the CSS transition duration

/**
 * Two voices, one bubble — her ambient hook lines and her replies to the owner
 * both land here, and they can arrive milliseconds apart.
 *
 * The rule: **a chat line always takes the bubble; an ambient line is dropped
 * while a chat line is still on screen.** Both halves matter and both are
 * tested. A reply must win over an ambient line that arrived at the same moment
 * (he asked a question; the answer is the point), and an ambient line must not
 * stomp a reply he is still reading (being interrupted by a status update
 * mid-answer is exactly what makes a pet feel deaf).
 *
 * The hold is the existing TTL, not a second timer: an ambient line is refused
 * only while the chat line is *visible*, so the bubble opens back up to ambient
 * lines the moment the chat line starts to fade. Chat lines never block each
 * other — equal priority replaces, which is how the pending "thinking" state is
 * taken back down by the real reply.
 */
export const BUBBLE_PRIORITY = Object.freeze({ ambient: 0, chat: 1 });

/**
 * The wordless pending state: `thinking()` puts these three dots in the bubble
 * and lets `styles.css` pulse them.
 *
 * It used to be a sentence — "Let me think for a moment…" — and the trouble with
 * a sentence is that it is the *same* sentence on every turn. Said once it is in
 * character; said before every answer she ever gives, it is filler, and it makes
 * her look like she is stalling rather than thinking. Dots say the one thing
 * that actually needs saying, which is that she heard him and something is
 * happening.
 *
 * Deliberately still text in the same bubble rather than a second element: the
 * priority arbitration above then needs no changes at all. A pending exchange
 * holds the bubble against ambient lines exactly as the sentence did, and the
 * reply replaces it simply by being the newer chat line.
 */
export const THINKING_MARK = '•••';

/** Set while the dots are up; the only thing `styles.css` animates. */
export const THINKING_CLASS = 'is-thinking';

/**
 * @param {object} opts
 * @param {{textContent: string, hidden: boolean, classList: {add: Function, remove: Function}}} opts.el
 * @param {(fn: Function, ms: number) => any} [opts.schedule]
 * @param {(handle: any) => void} [opts.cancel]
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.fadeMs]
 */
export function createBubbles({
  el,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  ttlMs = BUBBLE_TTL_MS,
  fadeMs = BUBBLE_FADE_MS,
} = {}) {
  if (!el) throw new TypeError('createBubbles requires an element');

  let fadeTimer = null;
  let clearTimer = null;
  let visible = false;
  let priority = BUBBLE_PRIORITY.ambient;

  function clearTimers() {
    if (fadeTimer !== null) cancel(fadeTimer);
    if (clearTimer !== null) cancel(clearTimer);
    fadeTimer = null;
    clearTimer = null;
  }

  function hideNow() {
    clearTimers();
    visible = false;
    priority = BUBBLE_PRIORITY.ambient;
    el.classList.remove('is-visible');
    el.classList.remove(THINKING_CLASS);
    el.hidden = true;
    el.textContent = '';
  }

  function put(line, want) {
    if (visible && want < priority) return false;
    priority = want;
    clearTimers();
    // Whatever put the dots up, showing anything at all takes them down: the
    // reply, the failure line, or a later ambient line. Keeping that here rather
    // than beside the caller is what makes it a guarantee instead of something
    // three call sites have to remember.
    el.classList.remove(THINKING_CLASS);
    // textContent, never innerHTML: this string comes from an LLM.
    el.textContent = line;
    el.hidden = false;
    el.classList.add('is-visible');
    visible = true;
    fadeTimer = schedule(() => {
      fadeTimer = null;
      visible = false;
      // The hold ends with the line: a fading reply no longer blocks ambient.
      priority = BUBBLE_PRIORITY.ambient;
      el.classList.remove('is-visible');
      clearTimer = schedule(() => {
        clearTimer = null;
        el.hidden = true;
        el.classList.remove(THINKING_CLASS);
        el.textContent = '';
      }, fadeMs);
    }, ttlMs);
    return true;
  }

  return {
    /**
     * Show a line. Ignores blank text. Resets the 8s timer on every call.
     * Returns false when the line was refused — blank, or outranked by a chat
     * line still on screen (see BUBBLE_PRIORITY).
     */
    show(text, { priority: want = BUBBLE_PRIORITY.ambient } = {}) {
      const line = typeof text === 'string' ? text.trim() : '';
      if (!line) return false;
      return put(line, want);
    },

    /**
     * Raise the wordless pending state (see THINKING_MARK). Chat priority, so it
     * holds the bubble against ambient lines for as long as a sentence did, and
     * so the reply — also chat priority — replaces it rather than being refused.
     */
    thinking() {
      const shown = put(THINKING_MARK, BUBBLE_PRIORITY.chat);
      if (shown) el.classList.add(THINKING_CLASS);
      return shown;
    },

    /** Immediate teardown (no fade). */
    hide: hideNow,

    get visible() {
      return visible;
    },

    /** Priority of the line currently holding the bubble. */
    get priority() {
      return priority;
    },

    /** True while the dots are up rather than words. */
    get isThinking() {
      return el.classList.contains(THINKING_CLASS);
    },

    get text() {
      return el.textContent;
    },
  };
}
