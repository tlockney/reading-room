import { assert } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const ROOT = dirname(fromFileUrl(import.meta.url));
const SKILL = join(ROOT, "skill/editorial-longform-html/assets/engineering-reference.html");

// The skill template inlines the canonical zoom+theme bundle verbatim so its
// standalone docs carry the same features render.ts injects. This test pins the
// two copies together.
Deno.test("skill template embeds the canonical editorial bundle verbatim", async () => {
  const template = await Deno.readTextFile(SKILL);
  const head = await Deno.readTextFile(join(ROOT, "assets/editorial/head.html"));
  const body = await Deno.readTextFile(join(ROOT, "assets/editorial/body.html"));
  assert(template.includes(head.trim()), "skill template is missing/stale head.html bundle");
  assert(template.includes(body.trim()), "skill template is missing/stale body.html bundle");
});
