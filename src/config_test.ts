import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { join, resolve } from "jsr:@std/path@1";
import { DEFAULT_SITE, loadSite, makeContext, parseSite, resolveHome } from "./config.ts";

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

Deno.test("resolveHome: --root flag wins over env", () => {
  Deno.env.set("READING_ROOM_HOME", "/from/env");
  try {
    assertEquals(resolveHome("/from/flag"), resolve("/from/flag"));
  } finally {
    Deno.env.delete("READING_ROOM_HOME");
  }
});

Deno.test("resolveHome: READING_ROOM_HOME used when no flag", () => {
  Deno.env.set("READING_ROOM_HOME", "/srv/rr");
  try {
    assertEquals(resolveHome(), resolve("/srv/rr"));
  } finally {
    Deno.env.delete("READING_ROOM_HOME");
  }
});

Deno.test("resolveHome: XDG_DATA_HOME default when no flag/env", () => {
  Deno.env.delete("READING_ROOM_HOME");
  Deno.env.set("XDG_DATA_HOME", "/xdg");
  try {
    assertEquals(resolveHome(), join("/xdg", "reading-room"));
  } finally {
    Deno.env.delete("XDG_DATA_HOME");
  }
});

Deno.test("resolveHome: falls back to ~/.local/share/reading-room", () => {
  Deno.env.delete("READING_ROOM_HOME");
  Deno.env.delete("XDG_DATA_HOME");
  const savedHome = Deno.env.get("HOME");
  Deno.env.set("HOME", "/home/tester");
  try {
    assertEquals(resolveHome(), join("/home/tester", ".local", "share", "reading-room"));
  } finally {
    if (savedHome !== undefined) Deno.env.set("HOME", savedHome);
  }
});

Deno.test("resolveHome: empty XDG_DATA_HOME falls through to HOME, not a relative path", () => {
  Deno.env.delete("READING_ROOM_HOME");
  Deno.env.set("XDG_DATA_HOME", "");
  const savedHome = Deno.env.get("HOME");
  Deno.env.set("HOME", "/home/tester");
  try {
    assertEquals(resolveHome(), join("/home/tester", ".local", "share", "reading-room"));
  } finally {
    Deno.env.delete("XDG_DATA_HOME");
    if (savedHome !== undefined) Deno.env.set("HOME", savedHome);
  }
});
