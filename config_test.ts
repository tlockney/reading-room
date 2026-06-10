import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { DEFAULT_SITE, loadSite, makeContext, parseSite } from "./src/config.ts";

Deno.test("loadSite: missing site.jsonc falls back to defaults", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await loadSite(dir), DEFAULT_SITE);
});

Deno.test("loadSite: partial site.jsonc merges over defaults", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "site.jsonc"),
    `{ "title": "My Library", "footer": ["a", "b"] } // comment ok`,
  );
  const site = await loadSite(dir);
  assertEquals(site.title, "My Library");
  assertEquals(site.footer, ["a", "b"]);
  assertEquals(site.eyebrow, DEFAULT_SITE.eyebrow);
  assertEquals(site.lede, DEFAULT_SITE.lede);
});

Deno.test("loadSite: wrong field type is a clear error", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "site.jsonc"), `{ "footer": "not an array" }`);
  const err = await assertRejects(() => loadSite(dir));
  assert(String(err).includes("footer"));
});

Deno.test("parseSite: unknown field is a clear error", () => {
  assertEquals(parseSite({ titel: "typo" }), "unknown field: titel");
});

Deno.test("makeContext derives all paths from the root", async () => {
  const dir = await Deno.makeTempDir();
  const ctx = await makeContext(dir);
  assertEquals(ctx.registryPath, join(ctx.root, "registry.jsonc"));
  assertEquals(ctx.migratedDir, join(ctx.root, "_migrated"));
  assertEquals(ctx.commentsDir, join(ctx.root, "comments"));
  assert(ctx.root.startsWith("/"), "root is absolute");
  assertEquals(ctx.site, DEFAULT_SITE);
});
