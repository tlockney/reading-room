import { assert, assertEquals } from "jsr:@std/assert@1";
import { injectEditorialBody, injectEditorialHead, injectFavicon, stripAdmin } from "./render.ts";

const MINIMAL = `<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>`;

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

Deno.test("injectEditorialHead inserts the bundle before </head>", () => {
  const out = injectEditorialHead(MINIMAL);
  assert(out.includes("<!-- EDITORIAL-HEAD:start -->"));
  assert(out.indexOf("EDITORIAL-HEAD:start") < out.indexOf("</head>"));
});

Deno.test("injectEditorialHead is idempotent (applied twice == once)", () => {
  const once = injectEditorialHead(MINIMAL);
  const twice = injectEditorialHead(once);
  assertEquals(twice, once);
  assertEquals(count(twice, "EDITORIAL-HEAD:start"), 1);
});

Deno.test("injectEditorialBody is idempotent", () => {
  const once = injectEditorialBody(MINIMAL);
  const twice = injectEditorialBody(once);
  assertEquals(twice, once);
  assertEquals(count(twice, "EDITORIAL-BODY:start"), 1);
});

Deno.test("a baked-in (skill-authored) bundle is replaced, not duplicated", () => {
  // Simulate a standalone doc that already carries the bundle (stale copy).
  const baked = MINIMAL.replace(
    "</head>",
    "<!-- EDITORIAL-HEAD:start -->\n<style>.edzoom-able{color:red;/*STALE*/}</style>\n<!-- EDITORIAL-HEAD:end -->\n</head>",
  );
  const out = injectEditorialHead(baked);
  assertEquals(count(out, "EDITORIAL-HEAD:start"), 1);
  assertEquals(out.includes("/*STALE*/"), false); // replaced with current canonical
});

Deno.test("injectFavicon is RR-only and idempotent", () => {
  const once = injectFavicon(MINIMAL);
  assert(once.includes("favicon.svg"));
  const twice = injectFavicon(once);
  assertEquals(twice, once);
});

Deno.test("a baked-in admin block is stripped (and stripping is idempotent)", () => {
  const stale = MINIMAL.replace(
    "<p>hi</p>",
    `<p>hi</p>\n<!-- RR-ADMIN:start -->\n<script>window.__RR = {};</script>\n<!-- RR-ADMIN:end -->`,
  );
  const out = stripAdmin(stale);
  assertEquals(out.includes("RR-ADMIN"), false);
  assertEquals(out.includes("window.__RR"), false);
  assertEquals(stripAdmin(out), out);
});
