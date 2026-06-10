import { assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { generate } from "./scripts/gen-assets.ts";

const ROOT = dirname(fromFileUrl(import.meta.url));

Deno.test("src/assets_gen.ts is exactly what scripts/gen-assets.ts generates", async () => {
  const committed = await Deno.readTextFile(join(ROOT, "src/assets_gen.ts"));
  assertEquals(committed, await generate(ROOT), "stale — run: deno task gen");
});
