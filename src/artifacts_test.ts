import { assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  artifactUrl,
  deriveSlug,
  extractTitle,
  loadManifest,
  publishArtifact,
  removeArtifact,
  saveManifest,
  setArtifactTitle,
  slugify,
  updateArtifact,
} from "./artifacts.ts";
import { exists } from "jsr:@std/fs@1";

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

/** A temp content home + a source dir to build inputs in. */
async function scratch(): Promise<{ artifactsDir: string; manifestPath: string; srcDir: string }> {
  const root = await Deno.makeTempDir();
  const srcDir = join(root, "src");
  await Deno.mkdir(srcDir);
  return {
    artifactsDir: join(root, "artifacts"),
    manifestPath: join(root, "artifacts.json"),
    srcDir,
  };
}

Deno.test("publish a single HTML file: copy-in, title from <title>, entry=basename", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const file = join(srcDir, "report.html");
  await Deno.writeTextFile(
    file,
    "<html><head><title>Q3 Report</title></head><body>x</body></html>",
  );

  const art = await publishArtifact({ artifactsDir, manifestPath, srcPath: file });

  assertEquals(art.slug, "report");
  assertEquals(art.title, "Q3 Report");
  assertEquals(art.entry, "report.html");
  assertEquals(art.isDir, false);
  assertEquals(art.bytes > 0, true);
  assertEquals(await exists(join(artifactsDir, "report", "report.html")), true);
  assertEquals((await loadManifest(manifestPath)).length, 1);
});

Deno.test("publish a directory: index.html becomes entry, name overrides slug", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const site = join(srcDir, "site");
  await Deno.mkdir(site);
  await Deno.writeTextFile(
    join(site, "index.html"),
    "<html><head><title>Home</title></head></html>",
  );
  await Deno.writeTextFile(join(site, "app.js"), "console.log(1)");

  const art = await publishArtifact({
    artifactsDir,
    manifestPath,
    srcPath: site,
    name: "My Mockup",
  });

  assertEquals(art.slug, "my-mockup");
  assertEquals(art.isDir, true);
  assertEquals(art.entry, "index.html");
  assertEquals(await exists(join(artifactsDir, "my-mockup", "app.js")), true);
});

Deno.test("update re-snapshots content and bumps updatedAt; slug + title stay", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const file = join(srcDir, "a.html");
  await Deno.writeTextFile(file, "<title>One</title>");
  const first = await publishArtifact({ artifactsDir, manifestPath, srcPath: file });
  await Deno.writeTextFile(file, "<title>Two</title>");

  const updated = await updateArtifact({
    artifactsDir,
    manifestPath,
    slug: first.slug,
    srcPath: file,
  });
  assertEquals(updated?.title, "One"); // title is not re-derived on update; slug is stable
  assertEquals(
    await Deno.readTextFile(join(artifactsDir, first.slug, "a.html")),
    "<title>Two</title>",
  );
  assertEquals(updated!.updatedAt >= first.updatedAt, true);
  assertEquals(
    await updateArtifact({ artifactsDir, manifestPath, slug: "nope", srcPath: file }),
    null,
  );
});

Deno.test("setArtifactTitle edits the display title only", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const file = join(srcDir, "a.html");
  await Deno.writeTextFile(file, "<title>Old</title>");
  const art = await publishArtifact({ artifactsDir, manifestPath, srcPath: file });

  const renamed = await setArtifactTitle({ manifestPath, slug: art.slug, title: "New Name" });
  assertEquals(renamed?.title, "New Name");
  assertEquals(renamed?.slug, art.slug); // slug unchanged
  assertEquals((await loadManifest(manifestPath))[0].title, "New Name");
  assertEquals(await setArtifactTitle({ manifestPath, slug: "nope", title: "x" }), null);
});

Deno.test("remove deletes the snapshot dir and manifest entry", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const file = join(srcDir, "a.html");
  await Deno.writeTextFile(file, "<title>A</title>");
  const art = await publishArtifact({ artifactsDir, manifestPath, srcPath: file });

  assertEquals(await removeArtifact({ artifactsDir, manifestPath, slug: art.slug }), true);
  assertEquals(await exists(join(artifactsDir, art.slug)), false);
  assertEquals(await loadManifest(manifestPath), []);
  assertEquals(await removeArtifact({ artifactsDir, manifestPath, slug: "gone" }), false);
});

Deno.test("artifactUrl builds a tailnet content URL", () => {
  assertEquals(
    artifactUrl("studio.tail1.ts.net", "mockup"),
    "https://studio.tail1.ts.net/artifacts/mockup/",
  );
});
