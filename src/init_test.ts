import { assert, assertEquals } from "jsr:@std/assert@1";
import { exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { ensureHome, initMain } from "./init.ts";

Deno.test("ensureHome creates dirs and an empty registry", async () => {
  const home = await Deno.makeTempDir();
  try {
    await ensureHome(home);
    assert(await exists(join(home, "_migrated")));
    assert(await exists(join(home, "comments")));
    assert(await exists(join(home, "registry.jsonc")));
    // No site.jsonc — identity stays DEFAULT_SITE under lazy create.
    assertEquals(await exists(join(home, "site.jsonc")), false);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("ensureHome does not clobber an existing registry", async () => {
  const home = await Deno.makeTempDir();
  try {
    const reg = join(home, "registry.jsonc");
    await Deno.writeTextFile(reg, "// mine\n[]\n");
    await ensureHome(home);
    assertEquals(await Deno.readTextFile(reg), "// mine\n[]\n");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("initMain scaffolds a home with a site.jsonc template and returns 0", async () => {
  const home = await Deno.makeTempDir();
  try {
    const code = await initMain(["--root", home]);
    assertEquals(code, 0);
    assert(await exists(join(home, "site.jsonc")));
    assert(await exists(join(home, "registry.jsonc")));
    assert(await exists(join(home, "_migrated")));
    assert(await exists(join(home, "comments")));
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("initMain is idempotent and never clobbers site.jsonc", async () => {
  const home = await Deno.makeTempDir();
  try {
    await initMain(["--root", home]);
    await Deno.writeTextFile(join(home, "site.jsonc"), '{ "title": "Mine" }\n');
    await initMain(["--root", home]);
    assertEquals(
      await Deno.readTextFile(join(home, "site.jsonc")),
      '{ "title": "Mine" }\n',
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
