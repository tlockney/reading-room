// @ts-check
/**
 * Reading Room — margin-card stacking. Pure, no DOM.
 *
 * Lays out annotation cards in the gutter so each sits at its anchor unless
 * an earlier card overlaps it, in which case it is pushed down (classic
 * review-comment layout). Shared verbatim by the browser admin layer
 * (assets/admin/admin.js imports it) and the Deno test suite (layout_test.ts).
 */

/**
 * Compute non-overlapping top positions for margin cards.
 * @param {Array<{anchor: number, height: number}>} entries desired anchor top
 *   plus measured height for each card, in ANY order
 * @param {number} [gap=8] minimum vertical gap between cards
 * @returns {number[]} a top per entry, aligned to the INPUT order; each is at
 *   its anchor or pushed just below the previous (by anchor) card
 */
export function stackTops(entries, gap = 8) {
  const order = entries.map((_, i) => i).sort((a, b) => entries[a].anchor - entries[b].anchor);
  /** @type {number[]} */
  const tops = new Array(entries.length);
  let cursor = -Infinity;
  for (const i of order) {
    const top = Math.max(entries[i].anchor, cursor);
    tops[i] = top;
    cursor = top + entries[i].height + gap;
  }
  return tops;
}
