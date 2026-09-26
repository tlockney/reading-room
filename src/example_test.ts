import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { makeContext } from "./config.ts";
import { build } from "./build.ts";

const EXAMPLE = join(dirname(dirname(fromFileUrl(import.meta.url))), "example");

Deno.test("example content home builds with site config and slots applied", async () => {
  const out = await Deno.makeTempDir();
  try {
    const ctx = await makeContext(EXAMPLE);
    const res = await build(ctx, { outDir: out });
    // every registered doc builds (the dev library grows; don't pin a count)
    const registry = await Deno.readTextFile(join(EXAMPLE, "registry.jsonc"));
    assertEquals(res.docs, registry.match(/"slug":/g)?.length);
    const index = await Deno.readTextFile(join(out, "index.html"));
    assert(index.includes("Example Reading Room")); // site.jsonc applied
    assert(index.includes("RR-LOCAL-HEAD")); // slot applied
    assert(!index.includes("RR-ADMIN")); // never in static output
    const doc = await Deno.readTextFile(join(out, "docs/welcome/index.html"));
    assert(doc.includes("EDITORIAL-HEAD")); // canonical bundle injected
    assert(doc.includes("RR-LOCAL-HEAD"));
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
