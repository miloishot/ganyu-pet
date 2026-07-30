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
 * other — equal priority replaces, which is how the pending "thinking" line is
 * taken back down by the real reply.
 */
export const BUBBLE_PRIORITY = Object.freeze({ ambient: 0, chat: 1 });

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
    el.hidden = true;
    el.textContent = '';
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
      if (visible && want < priority) return false;
      priority = want;
      clearTimers();
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
          el.textContent = '';
        }, fadeMs);
      }, ttlMs);
      return true;
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

    get text() {
      return el.textContent;
    },
  };
}
