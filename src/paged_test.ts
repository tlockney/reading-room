import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

/**
 * The paged-reading script lives inline in the editorial body partial. It
 * exposes its pure paging math as `window.__edpaged` before touching the DOM
 * and defers everything else to DOMContentLoaded, so we can evaluate it against
 * a minimal fake document (the same approach `sw_behavior_test.ts` takes with
 * the generated service worker) and drive the math without a browser.
 */

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const body = await Deno.readTextFile(join(ROOT, "assets/editorial/body.html"));

type Mark = { id: string; page: number };
type Anchor = { id: string | null; delta: number };
type Paged = {
  pageOf(x: number, w: number): number;
  count(scrollWidth: number, w: number): number;
  snap(page: number, dx: number, w: number, vx: number, count: number): number;
  anchorFor(marks: Mark[], page: number): Anchor;
  restore(marks: Mark[], saved: Anchor | null, count: number): number;
};

function loadPaged(opts: { optOut?: boolean } = {}): Paged | undefined {
  const scripts = body.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
  const src = scripts.find((s) => s.includes("window.__edpaged"));
  assert(src, "body partial must carry the paged-reading script");
  const code = src.replace(/^<script>/, "").replace(/<\/script>$/, "");
  const win: Record<string, unknown> = {};
  const listeners: string[] = [];
  const doc = {
    readyState: "loading",
    addEventListener: (type: string) => listeners.push(type),
    documentElement: {
      getAttribute: (name: string) => (opts.optOut && name === "data-ed-paged") ? "off" : null,
      classList: { contains: () => false },
    },
  };
  new Function("window", "document", code)(win, doc);
  if (!opts.optOut) assertEquals(listeners, ["DOMContentLoaded"], "init must be deferred");
  return win.__edpaged as Paged | undefined;
}

const P = loadPaged()!;

Deno.test("paged script exposes its math and defers DOM work", () => {
  assert(P, "window.__edpaged missing");
  for (const k of ["pageOf", "count", "snap", "anchorFor", "restore"]) {
    assertEquals(typeof (P as unknown as Record<string, unknown>)[k], "function", k);
  }
});

Deno.test("paged script still publishes its math when opted out (no DOM listeners)", () => {
  assert(loadPaged({ optOut: true }));
});

Deno.test("pageOf maps an x-offset to its column, tolerant of sub-pixel drift", () => {
  assertEquals(P.pageOf(0, 375), 0);
  assertEquals(P.pageOf(374, 375), 1); // 374+1 rounds onto the next page boundary
  assertEquals(P.pageOf(374.6, 375), 1);
  assertEquals(P.pageOf(750, 375), 2);
  assertEquals(P.pageOf(-3, 375), 0);
  assertEquals(P.pageOf(500, 0), 0, "zero width never divides");
});

Deno.test("count rounds the multicol scroll width to whole pages, never below one", () => {
  assertEquals(P.count(375 * 12, 375), 12);
  assertEquals(P.count(375 * 12 + 2, 375), 12);
  assertEquals(P.count(100, 375), 1);
  assertEquals(P.count(0, 0), 1);
});

Deno.test("snap commits a turn past 20% of the width or on a flick", () => {
  const w = 375;
  assertEquals(P.snap(3, -100, w, -0.1, 10), 4, "long drag left → next");
  assertEquals(P.snap(3, 100, w, 0.1, 10), 2, "long drag right → previous");
  assertEquals(P.snap(3, -30, w, -0.1, 10), 3, "short slow drag → stay");
  assertEquals(P.snap(3, -30, w, -0.9, 10), 4, "short fast flick → next");
  assertEquals(P.snap(3, 30, w, 0.9, 10), 2, "short fast flick → previous");
});

Deno.test("snap clamps at the covers", () => {
  assertEquals(P.snap(0, 200, 375, 1, 10), 0);
  assertEquals(P.snap(9, -200, 375, -1, 10), 9);
});

const MARKS: Mark[] = [
  { id: "intro", page: 1 },
  { id: "part-one", page: 4 },
  { id: "part-two", page: 9 },
];

Deno.test("anchorFor records the last mark at or before the page plus the pages past it", () => {
  assertEquals(P.anchorFor(MARKS, 0), { id: null, delta: 0 });
  assertEquals(P.anchorFor(MARKS, 1), { id: "intro", delta: 0 });
  assertEquals(P.anchorFor(MARKS, 6), { id: "part-one", delta: 2 });
  assertEquals(P.anchorFor(MARKS, 11), { id: "part-two", delta: 2 });
});

Deno.test("restore re-resolves an anchor against fresh marks after a reflow", () => {
  // A reflow (fonts, orientation) shifted every heading by two pages.
  const reflowed = MARKS.map((m) => ({ ...m, page: m.page + 2 }));
  assertEquals(P.restore(reflowed, { id: "part-one", delta: 2 }, 20), 8);
  assertEquals(P.restore(reflowed, { id: null, delta: 0 }, 20), 0);
});

Deno.test("restore tolerates a missing anchor, a vanished id, and clamps to the count", () => {
  assertEquals(P.restore(MARKS, null, 20), 0);
  assertEquals(P.restore(MARKS, { id: "gone", delta: 3 }, 20), 3, "unknown id falls back to 0");
  assertEquals(P.restore(MARKS, { id: "part-two", delta: 40 }, 12), 11);
});

Deno.test("anchorFor → restore round-trips on a stable layout", () => {
  for (let page = 0; page < 12; page++) {
    assertEquals(P.restore(MARKS, P.anchorFor(MARKS, page), 12), page);
  }
});
