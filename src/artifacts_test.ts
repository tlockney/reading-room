import { assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { deriveSlug, extractTitle, loadManifest, saveManifest, slugify } from "./artifacts.ts";

Deno.test("slugify lowercases and hyphenates", () => {
  assertEquals(slugify("Landing Page Mockup!"), "landing-page-mockup");
  assertEquals(slugify("  Q3 Report (final) "), "q3-report-final");
  assertEquals(slugify("already-ok_1"), "already-ok_1");
});

Deno.test("deriveSlug dedupes against taken slugs", () => {
  assertEquals(deriveSlug("mockup", []), "mockup");
  assertEquals(deriveSlug("Mockup", ["mockup"]), "mockup-2");
  assertEquals(deriveSlug("mockup", ["mockup", "mockup-2"]), "mockup-3");
});

Deno.test("deriveSlug falls back when a name slugifies to empty", () => {
  assertEquals(deriveSlug("!!!", []), "artifact");
  assertEquals(deriveSlug("***", ["artifact"]), "artifact-2");
});

Deno.test("extractTitle reads the first <title>, else null", () => {
  assertEquals(extractTitle("<html><head><title> Hi There </title></head></html>"), "Hi There");
  assertEquals(extractTitle("<p>no title</p>"), null);
});

Deno.test("manifest round-trips; missing file loads as empty", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "artifacts.json");
  assertEquals(await loadManifest(path), []);
  const list = [{
    slug: "a",
    title: "A",
    entry: "index.html",
    isDir: true,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    bytes: 10,
  }];
  await saveManifest(path, list);
  assertEquals(await loadManifest(path), list);
  await Deno.remove(dir, { recursive: true });
});
