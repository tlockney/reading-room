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
