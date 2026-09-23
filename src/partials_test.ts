import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const head = await Deno.readTextFile(join(ROOT, "assets/editorial/head.html"));
const body = await Deno.readTextFile(join(ROOT, "assets/editorial/body.html"));

Deno.test("head partial carries EDITORIAL-HEAD markers", () => {
  assert(head.includes("<!-- EDITORIAL-HEAD:start -->"));
  assert(head.includes("<!-- EDITORIAL-HEAD:end -->"));
});

Deno.test("body partial carries EDITORIAL-BODY markers", () => {
  assert(body.includes("<!-- EDITORIAL-BODY:start -->"));
  assert(body.includes("<!-- EDITORIAL-BODY:end -->"));
});

Deno.test("partials use the unified ed* naming", () => {
  assert(head.includes(".edzoom-able"));
  assert(head.includes(".edtheme"));
  assert(head.includes("editorial-theme")); // localStorage key
  assert(body.includes("window.__edzoom"));
  assert(body.includes("window.__edtheme"));
  assert(body.includes('class="edtheme"'));
});

Deno.test("partials carry no legacy rr*/fig* names", () => {
  for (const [name, text] of [["head", head], ["body", body]] as const) {
    for (const legacy of ["rrzoom", "figzoom", "rrtheme", "rr-theme"]) {
      assertEquals(text.includes(legacy), false, `${name} still contains ${legacy}`);
    }
  }
});

Deno.test("head defines dark theme + mobile fixes", () => {
  assert(head.includes('[data-theme="dark"]'));
  assert(head.includes("max-width:720px"));
});

Deno.test("body zoom supports multi-pointer pinch", () => {
  assert(body.includes("pointers")); // pinch uses a pointer map
  assert(body.includes("setPointerCapture"));
});

Deno.test("hint is a CSS pseudo-element, not a DOM span (Mermaid-safe)", () => {
  // The hint must be CSS-only so async renderers (Mermaid rewrites its host's
  // innerHTML) can't wipe an appended span. See render of mermaid diagrams.
  assert(head.includes(".edzoom-able::after"));
  assert(head.includes('content:"Click to zoom"'));
  assertEquals(body.includes("edzoom-hint"), false, "body must not create a hint span");
  assertEquals(body.includes("createElement('span')"), false);
});

Deno.test("partials carry the paged-reading mode (narrow viewports, opt-out, chrome)", () => {
  assert(head.includes(".edpaged-toggle"));
  assert(head.includes('[data-ed-paged="on"] body'));
  assert(head.includes("column-width:100vw"));
  assert(head.includes('[data-ed-paged="off"] .edpaged-toggle{display:none !important;}'));
  assert(head.includes("editorial-paged")); // localStorage key, no-flash restore
  assert(body.includes("window.__edpaged"));
  assert(body.includes('class="edpaged-toggle"'));
  assert(body.includes("getAttribute('data-ed-paged')==='off'"));
});

Deno.test("paged mode is offered on phones and on touch devices in portrait, in CSS and both scripts", () => {
  // One query, three places: the CSS block, the head no-flash restore, and the
  // body script's live matchMedia. Tablets in landscape deliberately fall back
  // to scrolling (that orientation means zooming in and reading by scroll).
  const q = "(max-width:720px),(pointer:coarse) and (orientation:portrait)";
  assert(head.includes(`@media ${q}{`), "CSS block");
  assert(head.includes(`matchMedia('${q}')`), "head no-flash restore");
  assert(body.includes(`matchMedia('${q}')`), "body live query");
});
