import { assertEquals } from "jsr:@std/assert@1";
import { parsePublishConfig, resolveCmd } from "./publish.ts";

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
