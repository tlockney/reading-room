import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  forceDossierThemeOff,
  injectEditorialBody,
  injectEditorialHead,
  injectFavicon,
  portableHtml,
  renderIndex,
  stripAdmin,
} from "./render.ts";
import { DEFAULT_SITE } from "./config.ts";

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

Deno.test("renderIndex tags the eyebrow with the instance name when given", () => {
  const html = renderIndex(DEFAULT_SITE, [], "Studio");
  assertStringIncludes(html, `<div class="eyebrow">${DEFAULT_SITE.eyebrow} · Studio</div>`);
});

Deno.test("renderIndex omits the instance tag with no name (build purity)", () => {
  const html = renderIndex(DEFAULT_SITE, []);
  assertStringIncludes(html, `<div class="eyebrow">${DEFAULT_SITE.eyebrow}</div>`);
});

Deno.test("editorial head includes theme-opt-out CSS rule", () => {
  const out = injectEditorialHead(MINIMAL);
  assertStringIncludes(out, '[data-ed-theme="off"] .edtheme{display:none !important;}');
});

Deno.test("editorial head no-flash script forces light when opted out", () => {
  const dossier = MINIMAL.replace("<html>", '<html data-ed-theme="off">');
  const out = injectEditorialHead(dossier);
  // The opt-out guard must appear before the localStorage / dark-pref logic
  assertStringIncludes(out, "data-ed-theme");
  assertStringIncludes(out, "setAttribute('data-theme','light')");
});

Deno.test("editorial body toggle script bails out when opted out", () => {
  const out = injectEditorialBody(MINIMAL);
  assertStringIncludes(out, "getAttribute('data-ed-theme')==='off'");
});

// A doc bearing the field-dossier signature: cover band + verdigris accent.
const DOSSIER = `<!DOCTYPE html><html lang="en"><head><title>x</title>` +
  `<style>:root{--verdigris:#2E6E64;}</style></head>` +
  `<body><header class="cover reveal"><h1>x</h1></header></body></html>`;

Deno.test("forceDossierThemeOff adds the opt-out to a dossier doc", () => {
  const out = forceDossierThemeOff(DOSSIER);
  assertStringIncludes(out, '<html lang="en" data-ed-theme="off">');
});

Deno.test("forceDossierThemeOff is idempotent and respects an existing value", () => {
  const once = forceDossierThemeOff(DOSSIER);
  assertEquals(forceDossierThemeOff(once), once);
  const pinned = DOSSIER.replace('<html lang="en">', '<html lang="en" data-ed-theme="on">');
  assertEquals(forceDossierThemeOff(pinned), pinned);
});

Deno.test("forceDossierThemeOff leaves non-dossier docs alone", () => {
  // No cover band, no verdigris accent — the editorial style keeps its toggle.
  assertEquals(forceDossierThemeOff(MINIMAL), MINIMAL);
  // A `cover-inner`-style class token is not the cover band itself, and a
  // stray --verdigris mention (e.g. a code sample) alone doesn't qualify.
  const nearMiss = MINIMAL.replace(
    "<p>hi</p>",
    '<div class="cover-inner">x</div><code>--verdigris: teal</code>',
  );
  assertEquals(forceDossierThemeOff(nearMiss), nearMiss);
});

// A source doc as it might look after being saved off a served page: every
// server-tied region baked in, plus a stale editorial bundle.
const SERVED_LIKE = [
  "<!DOCTYPE html><html><head><title>x</title>",
  '<!-- EDITORIAL-FAVICON:start -->\n<link rel="icon" href="/favicon.svg">\n<!-- EDITORIAL-FAVICON:end -->',
  "<!-- EDITORIAL-HEAD:start -->\n<style>/*STALE*/</style>\n<!-- EDITORIAL-HEAD:end -->",
  "<!-- RR-LOCAL-HEAD:start -->\n<style>/*LOCAL*/</style>\n<!-- RR-LOCAL-HEAD:end -->",
  "</head><body>",
  "<!-- READING-ROOM-NAV:start -->\n<div data-library-nav>nav</div>\n<!-- READING-ROOM-NAV:end -->",
  '<p>hi <a href="b.html#frag">sibling</a></p>',
  "<!-- RR-ADMIN:start -->\n<script>window.__RR = {};</script>\n<!-- RR-ADMIN:end -->",
  "<!-- RR-LOCAL-BODY:start -->\n<div>banner</div>\n<!-- RR-LOCAL-BODY:end -->",
  "</body></html>",
].join("\n");

Deno.test("portableHtml strips every server-tied region", () => {
  const out = portableHtml(SERVED_LIKE);
  assertEquals(out.includes("READING-ROOM-NAV"), false);
  // the canonical head bundle CSS mentions the [data-library-nav] selector;
  // what must be gone is the injected nav element itself
  assertEquals(out.includes("<div data-library-nav"), false);
  assertEquals(out.includes("EDITORIAL-FAVICON"), false);
  assertEquals(out.includes("favicon.svg"), false);
  assertEquals(out.includes("RR-ADMIN"), false);
  assertEquals(out.includes("window.__RR"), false);
  assertEquals(out.includes("RR-LOCAL-HEAD"), false);
  assertEquals(out.includes("RR-LOCAL-BODY"), false);
  assertEquals(out.includes("/*LOCAL*/"), false);
});

Deno.test("portableHtml heals a stale editorial bundle to the current canonical", () => {
  const out = portableHtml(SERVED_LIKE);
  assertEquals(count(out, "EDITORIAL-HEAD:start"), 1);
  assertEquals(count(out, "EDITORIAL-BODY:start"), 1);
  assertEquals(out.includes("/*STALE*/"), false);
});

Deno.test("portableHtml leaves source hrefs as authored (no /docs rewrite)", () => {
  const out = portableHtml(SERVED_LIKE);
  assertStringIncludes(out, 'href="b.html#frag"');
});

Deno.test("portableHtml is idempotent", () => {
  const once = portableHtml(SERVED_LIKE);
  assertEquals(portableHtml(once), once);
});

Deno.test("portableHtml forces the dossier theme opt-out, like serving does", () => {
  const out = portableHtml(DOSSIER);
  assertStringIncludes(out, '<html lang="en" data-ed-theme="off">');
});
