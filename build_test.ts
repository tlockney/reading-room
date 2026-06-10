import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { build, filterShared } from "./src/build.ts";
import { MIGRATED } from "./src/render.ts";
import type { Topic } from "./src/render.ts";

const doc = (slug: string, visibility?: "private" | "shared") => ({
  slug,
  title: slug,
  kind: "k",
  desc: "d",
  footLeft: "l",
  footRight: "r",
  src: `${slug}.html`,
  ...(visibility ? { visibility } : {}),
});

const CORPUS: Topic[] = [
  {
    num: "§ 01",
    id: "a",
    name: "A",
    short: "A",
    docs: [doc("one", "shared"), doc("two", "private")],
  },
  { num: "§ 02", id: "b", name: "B", short: "B", docs: [doc("three", "private")] },
  { num: "§ 03", id: "c", name: "C", short: "C", docs: [doc("four")] }, // visibility absent → private
];

Deno.test("filterShared keeps only shared docs and drops empty topics", () => {
  const out = filterShared(CORPUS);
  assertEquals(out.map((t) => t.id), ["a"]);
  assertEquals(out[0].docs.map((d) => d.slug), ["one"]);
});

Deno.test("filterShared of an all-private corpus is empty", () => {
  assertEquals(filterShared([CORPUS[1]]), []);
});

Deno.test("filterShared does not mutate its input", () => {
  filterShared(CORPUS);
  assertEquals(CORPUS[0].docs.length, 2);
});

// Build the real corpus to a temp dir and pin publish purity on actual output.
// Uses a throwaway fixture doc in _migrated/ that even carries a STALE admin
// block — transformDoc must strip it from built output.
Deno.test("built output carries no admin layer, even from contaminated sources", async () => {
  const slug = "zz-build-test-fixture";
  const fixture = join(MIGRATED, `${slug}.html`);
  const tmpRegistry = await Deno.makeTempFile({ suffix: ".jsonc" });
  const out = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      fixture,
      `<!DOCTYPE html><html><head><title>f</title></head><body><p>fixture</p>\n` +
        `<!-- RR-ADMIN:start -->\n<script>window.__RR = {};</script>\n<!-- RR-ADMIN:end -->\n</body></html>`,
    );
    await Deno.writeTextFile(
      tmpRegistry,
      `[{"num":"§ 01","id":"t","name":"T","short":"T","docs":[
      {"slug":"${slug}","title":"F","kind":"k","desc":"d","footLeft":"l","footRight":"r",
       "src":"reading-room/_migrated/${slug}.html","visibility":"shared"}]}]`,
    );
    const res = await build({ outDir: out, sharedOnly: true, registryPath: tmpRegistry });
    assertEquals(res.docs, 1);
    const builtDoc = await Deno.readTextFile(join(out, "docs", slug, "index.html"));
    const builtIndex = await Deno.readTextFile(join(out, "index.html"));
    assertEquals(builtDoc.includes("RR-ADMIN"), false);
    assertEquals(builtDoc.includes("window.__RR"), false);
    assertEquals(builtIndex.includes("RR-ADMIN"), false);
    assert(builtDoc.includes("fixture")); // the content itself survived
    // icons copied for standalone publish dirs
    assert((await Deno.stat(join(out, "favicon.svg"))).isFile);
  } finally {
    await Deno.remove(fixture);
    await Deno.remove(tmpRegistry);
    await Deno.remove(out, { recursive: true });
  }
});
