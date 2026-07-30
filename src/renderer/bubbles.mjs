// Module C — speech bubble. Newest line replaces the current one; each line
// lives BUBBLE_TTL_MS then fades out (opacity transition lives in styles.css).
// Timers are injected so this file is testable without a DOM or a real clock.

export const BUBBLE_TTL_MS = 8000;
export const BUBBLE_FADE_MS = 400; // must be >= the CSS transition duration

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

  function clearTimers() {
    if (fadeTimer !== null) cancel(fadeTimer);
    if (clearTimer !== null) cancel(clearTimer);
    fadeTimer = null;
    clearTimer = null;
  }

  function hideNow() {
    clearTimers();
    visible = false;
    el.classList.remove('is-visible');
    el.hidden = true;
    el.textContent = '';
  }

  return {
    /** Show a line. Ignores blank text. Resets the 8s timer on every call. */
    show(text) {
      const line = typeof text === 'string' ? text.trim() : '';
      if (!line) return false;
      clearTimers();
      // textContent, never innerHTML: this string comes from an LLM.
      el.textContent = line;
      el.hidden = false;
      el.classList.add('is-visible');
      visible = true;
      fadeTimer = schedule(() => {
        fadeTimer = null;
        visible = false;
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

    get text() {
      return el.textContent;
    },
  };
}
