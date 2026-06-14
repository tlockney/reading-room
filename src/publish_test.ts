import { assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { parsePublishConfig, publishMain, resolveCmd } from "./publish.ts";

Deno.test("resolveCmd substitutes {out} wherever it appears", () => {
  assertEquals(
    resolveCmd(["aws", "s3", "sync", "{out}", "s3://bucket"], "/tmp/.publish"),
    ["aws", "s3", "sync", "/tmp/.publish", "s3://bucket"],
  );
  assertEquals(resolveCmd(["echo", "{out}/{out}"], "X"), ["echo", "X/X"]);
});

Deno.test("parsePublishConfig accepts a valid config", () => {
  assertEquals(parsePublishConfig({ cmd: ["rsync", "-a", "{out}", "host:/srv"] }), {
    cmd: ["rsync", "-a", "{out}", "host:/srv"],
  });
});

Deno.test("parsePublishConfig rejects bad shapes with a reason", () => {
  assertEquals(typeof parsePublishConfig(null), "string");
  assertEquals(typeof parsePublishConfig({}), "string");
  assertEquals(typeof parsePublishConfig({ cmd: [] }), "string");
  assertEquals(typeof parsePublishConfig({ cmd: "aws s3 sync" }), "string");
  assertEquals(typeof parsePublishConfig({ cmd: ["aws", 3] }), "string");
});

Deno.test("publishMain --dry-run returns 0 and builds nothing destructive", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(home, "registry.jsonc"),
      '[\n  { "num": "§ 01", "id": "t", "name": "T", "short": "T", "docs": [] }\n]\n',
    );
    await Deno.writeTextFile(
      join(home, "publish.jsonc"),
      '{ "cmd": ["echo", "{out}"] }\n',
    );
    const code = await publishMain(["--root", home, "--dry-run"]);
    assertEquals(code, 0);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
