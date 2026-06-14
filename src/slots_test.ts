import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { injectLocalSlots, loadSlots } from "./render.ts";

const PAGE = `<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>`;

Deno.test("loadSlots: absent files load as empty slots", async () => {
  const root = await Deno.makeTempDir();
  assertEquals(await loadSlots(root), { head: "", body: "" });
});

Deno.test("loadSlots: reads assets/head-extra.html and body-extra.html", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "assets"));
  await Deno.writeTextFile(join(root, "assets/head-extra.html"), "<style>.x{}</style>");
  await Deno.writeTextFile(join(root, "assets/body-extra.html"), "<script>1</script>");
  assertEquals(await loadSlots(root), { head: "<style>.x{}</style>", body: "<script>1</script>" });
});

Deno.test("injectLocalSlots: wraps content in markers before </head> and </body>", () => {
  const out = injectLocalSlots(PAGE, { head: "<style>.x{}</style>", body: "<script>1</script>" });
  assert(
    out.includes(
      "<!-- RR-LOCAL-HEAD:start -->\n<style>.x{}</style>\n<!-- RR-LOCAL-HEAD:end -->\n</head>",
    ),
  );
  assert(
    out.includes(
      "<!-- RR-LOCAL-BODY:start -->\n<script>1</script>\n<!-- RR-LOCAL-BODY:end -->\n</body>",
    ),
  );
});

Deno.test("injectLocalSlots: idempotent and healing — stale regions are replaced", () => {
  const once = injectLocalSlots(PAGE, { head: "OLD", body: "OLD" });
  const twice = injectLocalSlots(once, { head: "<b>new</b>", body: "" });
  assert(!twice.includes("OLD"));
  assert(twice.includes("<b>new</b>"));
  assert(!twice.includes("RR-LOCAL-BODY")); // empty slot leaves no region behind
  assertEquals(injectLocalSlots(twice, { head: "<b>new</b>", body: "" }), twice);
});

Deno.test("injectLocalSlots: empty slots are a no-op on a clean page", () => {
  assertEquals(injectLocalSlots(PAGE, { head: "", body: "" }), PAGE);
});
