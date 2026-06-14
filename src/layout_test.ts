import { assertEquals } from "jsr:@std/assert@1";
import { stackTops } from "../assets/admin/layout.js";

Deno.test("stackTops leaves non-overlapping entries at their anchors", () => {
  assertEquals(
    stackTops([{ anchor: 100, height: 40 }, { anchor: 200, height: 40 }], 8),
    [100, 200],
  );
});

Deno.test("stackTops pushes an overlapping entry below its predecessor", () => {
  assertEquals(
    stackTops([{ anchor: 100, height: 40 }, { anchor: 110, height: 40 }], 8),
    [100, 148], // 100 + 40 + 8
  );
});

Deno.test("stackTops cascades pushes through a cluster", () => {
  assertEquals(
    stackTops(
      [{ anchor: 100, height: 30 }, { anchor: 100, height: 30 }, { anchor: 120, height: 30 }],
      10,
    ),
    [100, 140, 180],
  );
});

Deno.test("stackTops returns tops aligned to the INPUT order, not sorted order", () => {
  assertEquals(
    stackTops([{ anchor: 300, height: 20 }, { anchor: 100, height: 20 }], 8),
    [300, 100], // input order preserved; no overlap so both at anchors
  );
  assertEquals(
    stackTops([{ anchor: 105, height: 40 }, { anchor: 100, height: 40 }], 8),
    [148, 100], // the later-anchored entry is the one pushed, wherever it sits in input
  );
});

Deno.test("stackTops handles empty input", () => {
  assertEquals(stackTops([], 8), []);
});
