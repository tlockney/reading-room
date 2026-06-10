import { assertEquals } from "jsr:@std/assert@1";
import { describeRange, findAnchor } from "./assets/admin/anchor.js";

const TEXT =
  "The loop is the expensive part. The loop is also the fun part. End of the loop story.";

Deno.test("findAnchor prefers prefix+quote+suffix", () => {
  // "The loop is" appears twice; context picks the second
  const hit = findAnchor(TEXT, { prefix: "part. ", quote: "The loop is", suffix: " also" });
  assertEquals(hit, { start: 32, end: 43 });
});

Deno.test("findAnchor falls back to prefix+quote", () => {
  const hit = findAnchor(TEXT, { prefix: "part. ", quote: "The loop is", suffix: "ZZZ" });
  assertEquals(hit, { start: 32, end: 43 });
});

Deno.test("findAnchor falls back to quote+suffix", () => {
  const hit = findAnchor(TEXT, { prefix: "ZZZ", quote: "The loop is", suffix: " also" });
  assertEquals(hit, { start: 32, end: 43 });
});

Deno.test("findAnchor falls back to a unique bare quote", () => {
  const hit = findAnchor(TEXT, { prefix: "ZZZ", quote: "expensive", suffix: "ZZZ" });
  assertEquals(hit, { start: 16, end: 25 });
});

Deno.test("findAnchor orphans an ambiguous bare quote (no context match)", () => {
  assertEquals(findAnchor(TEXT, { prefix: "ZZZ", quote: "The loop is", suffix: "ZZZ" }), null);
});

Deno.test("findAnchor returns null when the quote is gone", () => {
  assertEquals(findAnchor(TEXT, { prefix: "", quote: "vanished text", suffix: "" }), null);
  assertEquals(findAnchor(TEXT, { prefix: "", quote: "", suffix: "" }), null);
});

Deno.test("describeRange captures quote plus bounded context", () => {
  const d = describeRange(TEXT, 32, 43, 6);
  assertEquals(d, { quote: "The loop is", prefix: "part. ", suffix: " also " });
});

Deno.test("describeRange clamps context at the text edges", () => {
  const d = describeRange(TEXT, 0, 3, 32);
  assertEquals(d.prefix, "");
  assertEquals(d.quote, "The");
});

Deno.test("describeRange → findAnchor round-trips", () => {
  const d = describeRange(TEXT, 32, 43);
  assertEquals(findAnchor(TEXT, d), { start: 32, end: 43 });
});

Deno.test("describeRange → findAnchor round-trips across multibyte text", () => {
  const t = "Loops — the § of agents — repeat. Loops § again.";
  const d = describeRange(t, t.indexOf("repeat"), t.indexOf("repeat") + 6);
  assertEquals(findAnchor(t, d), { start: t.indexOf("repeat"), end: t.indexOf("repeat") + 6 });
});
