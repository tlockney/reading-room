import { assertEquals } from "jsr:@std/assert@1";
import { matchPeer, resolvePort } from "./transfer-cli.ts";

Deno.test("resolvePort: flag > $PORT > 8413", () => {
  assertEquals(resolvePort("9000", undefined), 9000);
  assertEquals(resolvePort(undefined, "7000"), 7000);
  assertEquals(resolvePort(undefined, undefined), 8413);
  assertEquals(resolvePort(undefined, "junk"), 8413);
});

Deno.test("matchPeer resolves by identity name, bare name, or url", () => {
  const peers = [
    { url: "https://studio.t.ts.net/", name: "studio", identity: { name: "Studio" } },
    { url: "https://box.t.ts.net/", name: "box" },
  ];
  assertEquals(matchPeer(peers, "Studio"), "https://studio.t.ts.net/");
  assertEquals(matchPeer(peers, "box"), "https://box.t.ts.net/");
  assertEquals(matchPeer(peers, "https://box.t.ts.net/"), "https://box.t.ts.net/");
  assertEquals(matchPeer(peers, "nope"), null);
});
