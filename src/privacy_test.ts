import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fullDiskAccessHint, protectedArea, watchSlow } from "./privacy.ts";

Deno.test("protectedArea flags external volumes, Desktop/Documents/Downloads, iCloud", () => {
  const h = "/Users/t";
  assertEquals(
    protectedArea("/Volumes/Secondary/reading-room", h),
    "an external or network volume",
  );
  assertEquals(protectedArea("/Users/t/Documents/rr", h), "the Documents folder");
  assertEquals(protectedArea("/Users/t/Desktop", h), "the Desktop folder");
  assertEquals(protectedArea("/Users/t/Downloads/x", h), "the Downloads folder");
  assertEquals(
    protectedArea("/Users/t/Library/Mobile Documents/com~apple~CloudDocs/rr", h),
    "iCloud Drive",
  );
});

Deno.test("protectedArea leaves local, unprotected paths alone", () => {
  const h = "/Users/t";
  assertEquals(protectedArea("/Users/t/.local/share/reading-room", h), undefined);
  assertEquals(protectedArea("/Users/t/DocumentsArchive/rr", h), undefined); // prefix, not child
  assertEquals(protectedArea("/VolumesX/rr", h), undefined);
  assertEquals(protectedArea("/Users/t/Documents/rr", ""), undefined); // no HOME known
});

Deno.test("fullDiskAccessHint names the home, the deno binary, and the way out", () => {
  const hint = fullDiskAccessHint("/Volumes/Secondary/rr", "/opt/homebrew/bin/deno");
  assertStringIncludes(hint, "/Volumes/Secondary/rr");
  assertStringIncludes(hint, "Full Disk Access to /opt/homebrew/bin/deno");
  assertStringIncludes(hint, "launchctl kickstart -k");
  assertStringIncludes(hint, "~/.local/share/reading-room");
});

Deno.test("watchSlow stays quiet when the promise settles in time", async () => {
  let slow = false;
  assertEquals(await watchSlow(Promise.resolve(7), 50, () => slow = true), 7);
  await new Promise((r) => setTimeout(r, 80));
  assert(!slow);
});

Deno.test("watchSlow calls onSlow once for a stalled promise and still returns its value", async () => {
  let slow = 0;
  const late = new Promise<string>((r) => setTimeout(() => r("done"), 60));
  assertEquals(await watchSlow(late, 10, () => slow++), "done");
  assertEquals(slow, 1);
});
