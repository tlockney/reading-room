import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  addComment,
  deleteComment,
  loadComments,
  parseCommentInput,
  setCommentReviewed,
} from "./comments.ts";

const INPUT = {
  quote: "the loop is the expensive part",
  prefix: "punchline: ",
  suffix: ".",
  note: "verify this claim",
};

Deno.test("loadComments returns [] when no sidecar exists", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await loadComments(dir, "ghost"), []);
});

Deno.test("addComment assigns id/created and persists", async () => {
  const dir = await Deno.makeTempDir();
  const c = await addComment(dir, "alpha", INPUT);
  assert(c.id.length > 0);
  assert(!Number.isNaN(Date.parse(c.created)));
  const all = await loadComments(dir, "alpha");
  assertEquals(all.length, 1);
  assertEquals(all[0].note, "verify this claim");
  // sidecar file is per-slug
  assert((await Deno.stat(join(dir, "alpha.json"))).isFile);
});

Deno.test("comments accumulate per slug, isolated across slugs", async () => {
  const dir = await Deno.makeTempDir();
  await addComment(dir, "alpha", INPUT);
  await addComment(dir, "alpha", { ...INPUT, note: "second" });
  await addComment(dir, "beta", { ...INPUT, note: "other doc" });
  assertEquals((await loadComments(dir, "alpha")).length, 2);
  assertEquals((await loadComments(dir, "beta")).length, 1);
});

Deno.test("deleteComment removes by id; false for unknown id", async () => {
  const dir = await Deno.makeTempDir();
  const c = await addComment(dir, "alpha", INPUT);
  assertEquals(await deleteComment(dir, "alpha", c.id), true);
  assertEquals(await loadComments(dir, "alpha"), []);
  assertEquals(await deleteComment(dir, "alpha", c.id), false);
});

Deno.test("parseCommentInput accepts a valid body", () => {
  assertEquals(parseCommentInput(INPUT), INPUT);
});

Deno.test("parseCommentInput rejects bad shapes with a reason", () => {
  assertEquals(typeof parseCommentInput(null), "string");
  assertEquals(typeof parseCommentInput("hi"), "string");
  assertEquals(typeof parseCommentInput({ ...INPUT, note: 7 }), "string");
  assertEquals(typeof parseCommentInput({ ...INPUT, note: "  " }), "string");
  assertEquals(typeof parseCommentInput({ ...INPUT, quote: "" }), "string");
  assertEquals(typeof parseCommentInput({ prefix: "", suffix: "", note: "n" }), "string"); // quote missing
  assertEquals(typeof parseCommentInput({ ...INPUT, note: "x".repeat(10_001) }), "string");
});

Deno.test("setCommentReviewed stamps, clears, and rejects unknown ids", async () => {
  const dir = await Deno.makeTempDir();
  const c = await addComment(dir, "alpha", INPUT);
  const marked = await setCommentReviewed(dir, "alpha", c.id, true);
  assert(marked !== null && typeof marked.reviewed === "string");
  assert(!Number.isNaN(Date.parse(marked.reviewed!)));
  assertEquals((await loadComments(dir, "alpha"))[0].reviewed, marked.reviewed);
  const cleared = await setCommentReviewed(dir, "alpha", c.id, false);
  assert(cleared !== null);
  assertEquals("reviewed" in (await loadComments(dir, "alpha"))[0], false);
  assertEquals(await setCommentReviewed(dir, "alpha", "nope", true), null);
});
