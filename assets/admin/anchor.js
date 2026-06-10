// @ts-check
/**
 * Reading Room — text-quote anchoring (W3C-annotation style). Pure, no DOM.
 *
 * Shared verbatim by the browser admin layer (assets/admin/admin.js imports
 * it as an ES module) and the Deno test suite (anchor_test.ts) — one file,
 * no drift. JSDoc types keep it honest under Deno's checker.
 */

/**
 * Locate `quote` inside `text`. Preference order:
 *  1. prefix + quote + suffix   2. prefix + quote
 *  3. quote + suffix            4. bare quote, only if unambiguous
 * @param {string} text
 * @param {{prefix?: string, quote: string, suffix?: string}} sel
 * @returns {{start: number, end: number} | null}
 */
export function findAnchor(text, { prefix = "", quote, suffix = "" }) {
  if (!quote) return null;
  /** @type {Array<[string, number]>} */
  const tries = [
    [prefix + quote + suffix, prefix.length],
    [prefix + quote, prefix.length],
    [quote + suffix, 0],
    [quote, 0],
  ];
  for (const [needle, offset] of tries) {
    const at = text.indexOf(needle);
    if (at !== -1) {
      if (needle === quote && text.indexOf(quote, at + 1) !== -1) return null;
      const start = at + offset;
      return { start, end: start + quote.length };
    }
  }
  return null;
}

/**
 * Describe a [start,end) selection as quote + surrounding context.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {number} [ctx=32] context chars captured on each side
 * @returns {{quote: string, prefix: string, suffix: string}}
 */
export function describeRange(text, start, end, ctx = 32) {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ctx), start),
    suffix: text.slice(end, end + ctx),
  };
}
