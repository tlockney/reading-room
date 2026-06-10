import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { type AdminContext, injectAdmin } from "./src/admin.ts";
import { renderIndex } from "./src/render.ts";
import type { Topic } from "./src/render.ts";
import { DEFAULT_SITE } from "./src/config.ts";

const ROOT = dirname(fromFileUrl(import.meta.url));
const MINIMAL = `<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>`;

const CTX: AdminContext = {
  page: "doc",
  readonly: false,
  doc: { slug: "alpha", review: true, visibility: "private" },
};

Deno.test("injectAdmin appends the bundle before </body> with markers", () => {
  const out = injectAdmin(MINIMAL, CTX);
  assert(out.includes("<!-- RR-ADMIN:start -->"));
  assert(out.includes("<!-- RR-ADMIN:end -->"));
  assert(out.indexOf("RR-ADMIN:start") < out.indexOf("</body>"));
  assert(out.includes(`src="/assets/admin/admin.js"`));
  assert(out.includes(`href="/assets/admin/admin.css"`));
});

Deno.test("injectAdmin embeds the context as parseable JSON", () => {
  const out = injectAdmin(MINIMAL, CTX);
  const m = out.match(/window\.__RR = (.*?);<\/script>/);
  assert(m, "context payload missing");
  const parsed = JSON.parse(m![1]) as AdminContext;
  assertEquals(parsed, CTX);
});

Deno.test("script payload cannot break out of its <script> tag", () => {
  // a hostile slug is impossible via the API (route regex), but pin the escape anyway
  const ctx: AdminContext = {
    page: "doc",
    readonly: false,
    doc: { slug: "</script><script>alert(1)", review: false, visibility: "private" },
  };
  const out = injectAdmin(MINIMAL, ctx);
  assertEquals(out.includes("</script><script>alert(1)"), false);
});

// --- the publish-purity guards ----------------------------------------------

Deno.test("static render path carries no admin layer", () => {
  const corpus: Topic[] = [{
    num: "§ 01",
    id: "t",
    name: "T",
    short: "T",
    docs: [{
      slug: "a",
      title: "A",
      kind: "k",
      desc: "d",
      footLeft: "l",
      footRight: "r",
      src: "a.html",
      review: true,
    }],
  }];
  assertEquals(renderIndex(DEFAULT_SITE, corpus).includes("RR-ADMIN"), false);
});

Deno.test("the static build path's import closure never touches admin.ts or comments.ts", async () => {
  const seen = new Set<string>();
  const queue = ["build.ts", "render.ts"];
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const src = await Deno.readTextFile(join(ROOT, "src", name));
    for (const m of src.matchAll(/from\s+"\.\/([A-Za-z0-9_./-]+\.ts)"/g)) {
      queue.push(m[1]);
    }
  }
  assert(!seen.has("admin.ts"), "build path must not import admin.ts");
  assert(!seen.has("comments.ts"), "build path must not import comments.ts");
  assert(seen.has("render.ts")); // sanity: the walker actually walked
});

Deno.test("the standalone skill template carries no admin layer", async () => {
  const tpl = await Deno.readTextFile(
    join(ROOT, "skill/editorial-longform-html/assets/engineering-reference.html"),
  );
  assertEquals(tpl.includes("RR-ADMIN"), false);
});
