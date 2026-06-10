import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { build, filterShared } from "./src/build.ts";
import { makeContext } from "./src/config.ts";
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

// Build a fixture content root to a temp dir and pin publish purity on actual
// output. The fixture doc in <root>/_migrated/ even carries a STALE admin
// block — transformDoc must strip it from built output.
Deno.test("built output carries no admin layer, even from contaminated sources", async () => {
  const slug = "zz-build-test-fixture";
  const root = await Deno.makeTempDir();
  const out = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "_migrated"));
    await Deno.mkdir(join(root, "assets"));
    await Deno.writeTextFile(join(root, "assets/head-extra.html"), "<style>/*local*/</style>");
    await Deno.writeTextFile(
      join(root, "_migrated", `${slug}.html`),
      `<!DOCTYPE html><html><head><title>f</title></head><body><p>fixture</p>\n` +
        `<!-- RR-ADMIN:start -->\n<script>window.__RR = {};</script>\n<!-- RR-ADMIN:end -->\n</body></html>`,
    );
    await Deno.writeTextFile(
      join(root, "registry.jsonc"),
      `[{"num":"§ 01","id":"t","name":"T","short":"T","docs":[
      {"slug":"${slug}","title":"F","kind":"k","desc":"d","footLeft":"l","footRight":"r",
       "src":"ignored/_migrated/${slug}.html","visibility":"shared"}]}]`,
    );
    const ctx = await makeContext(root);
    const res = await build(ctx, { outDir: out, sharedOnly: true });
    assertEquals(res.docs, 1);
    const builtDoc = await Deno.readTextFile(join(out, "docs", slug, "index.html"));
    const builtIndex = await Deno.readTextFile(join(out, "index.html"));
    assertEquals(builtDoc.includes("RR-ADMIN"), false);
    assertEquals(builtDoc.includes("window.__RR"), false);
    assertEquals(builtIndex.includes("RR-ADMIN"), false);
    assert(builtDoc.includes("fixture")); // the content itself survived
    // local slots ARE content: they ride along into static output
    assert(builtDoc.includes("RR-LOCAL-HEAD"));
    assert(builtDoc.includes("/*local*/"));
    assert(builtIndex.includes("RR-LOCAL-HEAD"));
    assert(builtIndex.includes("/*local*/"));
    // icons written from the embedded constants
    assert((await Deno.stat(join(out, "favicon.svg"))).isFile);
    assert((await Deno.stat(join(out, "apple-touch-icon.png"))).isFile);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(out, { recursive: true });
  }
});
