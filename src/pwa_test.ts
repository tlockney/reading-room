import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  precacheUrls,
  pwaRevision,
  renderManifest,
  renderServiceWorker,
  shortName,
} from "./pwa.ts";
import { DEFAULT_SITE } from "./config.ts";
import type { Topic } from "./render.ts";

const CORPUS: Topic[] = [{
  num: "§ 01",
  id: "a",
  name: "A",
  short: "A",
  docs: [
    {
      slug: "one",
      title: "One",
      kind: "k",
      desc: "d",
      footLeft: "l",
      footRight: "r",
      src: "one.html",
    },
    {
      slug: "two",
      title: "Two",
      kind: "k",
      desc: "d",
      footLeft: "l",
      footRight: "r",
      src: "two.html",
    },
  ],
}];

Deno.test("precacheUrls covers the shell and every local doc", () => {
  const urls = precacheUrls(CORPUS);
  for (
    const expected of [
      "/",
      "/favicon.svg",
      "/apple-touch-icon.png",
      "/icon-192.png",
      "/icon-512.png",
      "/manifest.webmanifest",
      "/docs/one",
      "/docs/two",
    ]
  ) {
    assert(urls.includes(expected), `missing ${expected}`);
  }
  assertEquals(urls.length, 8);
});

Deno.test("precacheUrls of an empty corpus still covers the shell", () => {
  const urls = precacheUrls([]);
  assert(urls.includes("/"));
  assert(!urls.some((u) => u.startsWith("/docs/")));
});

Deno.test("renderManifest is valid JSON with site identity and PWA icons", () => {
  const raw = renderManifest(DEFAULT_SITE);
  const m = JSON.parse(raw) as {
    name: string;
    short_name: string;
    description: string;
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; sizes: string }>;
  };
  assertEquals(m.name, DEFAULT_SITE.title);
  assertEquals(m.short_name, "Reading Room"); // "The Reading Room" → ≤12 chars
  assertEquals(m.description, DEFAULT_SITE.lede);
  assertEquals(m.start_url, "/");
  assertEquals(m.scope, "/");
  assertEquals(m.display, "standalone");
  const sizes = m.icons.map((i) => i.sizes);
  assert(sizes.includes("192x192"));
  assert(sizes.includes("512x512"));
  assert(sizes.includes("any"));
});

Deno.test("renderManifest round-trips a hostile site title through JSON", () => {
  const title = `</script><script>alert(1)`;
  const raw = renderManifest({ ...DEFAULT_SITE, title });
  const m = JSON.parse(raw) as { name: string };
  assertEquals(m.name, title);
  // served as a standalone .webmanifest (never inlined into a <script>), so
  // JSON escaping is sufficient — the value must survive a parse round-trip.
});

Deno.test("shortName strips The and caps at 12 chars", () => {
  assertEquals(shortName("The Reading Room"), "Reading Room");
  assertEquals(shortName("Reading Room"), "Reading Room");
  assertEquals(shortName("A Very Long Library Title"), "A Very Long");
  assertEquals(shortName("X"), "X");
});

Deno.test("renderServiceWorker embeds every doc URL and the shell", () => {
  const sw = renderServiceWorker(CORPUS);
  assert(sw.includes("serviceWorker") || sw.includes("self.addEventListener"));
  assertStringIncludes(sw, "/docs/one");
  assertStringIncludes(sw, "/docs/two");
  assertStringIncludes(sw, '"/"');
  assertStringIncludes(sw, "install");
  assertStringIncludes(sw, "activate");
  assertStringIncludes(sw, "fetch");
});

Deno.test("renderServiceWorker is deterministic for the same corpus", () => {
  assertEquals(renderServiceWorker(CORPUS), renderServiceWorker(CORPUS));
});

Deno.test("renderServiceWorker changes when the corpus changes", () => {
  const grown: Topic[] = [{
    ...CORPUS[0],
    docs: [...CORPUS[0].docs, {
      slug: "three",
      title: "Three",
      kind: "k",
      desc: "d",
      footLeft: "l",
      footRight: "r",
      src: "three.html",
    }],
  }];
  assert(renderServiceWorker(CORPUS) !== renderServiceWorker(grown));
});

Deno.test("pwaRevision is stable but reacts to the corpus", () => {
  const a = pwaRevision(CORPUS);
  const b = pwaRevision(CORPUS);
  assertEquals(a, b);
  const grown: Topic[] = [{
    ...CORPUS[0],
    docs: [...CORPUS[0].docs, {
      slug: "three",
      title: "Three",
      kind: "k",
      desc: "d",
      footLeft: "l",
      footRight: "r",
      src: "three.html",
    }],
  }];
  assert(a !== pwaRevision(grown));
});
