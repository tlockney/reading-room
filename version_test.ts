import { assertEquals } from "jsr:@std/assert@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { VERSION } from "./src/version.ts";

Deno.test("version.ts VERSION matches deno.jsonc version", async () => {
  const cfg = parseJsonc(await Deno.readTextFile("deno.jsonc")) as { version: string };
  assertEquals(VERSION, cfg.version);
});
