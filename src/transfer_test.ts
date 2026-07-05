import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { makeContext } from "./config.ts";
import { loadCorpus } from "./render.ts";
import { buildDocPayload, parseReceivedPayload } from "./transfer.ts";

const REGISTRY = `[
  { "num": "§ 01", "id": "essays", "name": "Essays", "short": "Essays",
    "docs": [
      { "slug": "alpha", "title": "Alpha", "kind": "Essay", "desc": "First.",
        "footLeft": "2026", "footRight": "src", "src": "home/_migrated/alpha.html", "visibility": "private" }
    ] }
]`;

async function room(): Promise<Awaited<ReturnType<typeof makeContext>>> {
  const parent = await Deno.makeTempDir();
  const root = join(parent, "home");
  await Deno.mkdir(join(root, "_migrated"), { recursive: true });
  await Deno.writeTextFile(join(root, "registry.jsonc"), REGISTRY);
  await Deno.writeTextFile(join(root, "site.jsonc"), `{ "instance": "Studio" }`);
  await Deno.writeTextFile(
    join(root, "_migrated", "alpha.html"),
    "<html><body>ALPHA</body></html>",
  );
  return await makeContext(root);
}

Deno.test("buildDocPayload gathers html + metadata from the _migrated override", async () => {
  const ctx = await room();
  const corpus = await loadCorpus(ctx.registryPath);
  const p = await buildDocPayload(ctx, corpus, "alpha", {});
  assertEquals(p.html.includes("ALPHA"), true);
  assertEquals(p.meta.slug, "alpha");
  assertEquals(p.meta.title, "Alpha");
  assertEquals(p.meta.originTopic, "essays");
  assertEquals(p.meta.origin, "Studio"); // resolveInstanceName(site.instance)
  assertEquals(p.comments, undefined); // withComments not set
});

Deno.test("buildDocPayload throws on an unknown slug", async () => {
  const ctx = await room();
  const corpus = await loadCorpus(ctx.registryPath);
  let threw = false;
  try {
    await buildDocPayload(ctx, corpus, "nope", {});
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("parseReceivedPayload accepts a good body and rejects malformed ones", () => {
  const good = {
    html: "<p>x</p>",
    meta: {
      slug: "a",
      title: "A",
      kind: "K",
      desc: "D",
      footLeft: "L",
      footRight: "R",
      originTopic: "t",
      visibility: "private",
      origin: "Box",
    },
  };
  const parsed = parseReceivedPayload(good);
  assert(typeof parsed !== "string", "good body should parse");
  assertEquals((parsed as { meta: { slug: string } }).meta.slug, "a");

  assertEquals(typeof parseReceivedPayload(null), "string");
  assertEquals(typeof parseReceivedPayload({ html: 1, meta: good.meta }), "string");
  assertEquals(
    typeof parseReceivedPayload({ html: "x", meta: { ...good.meta, visibility: "bad" } }),
    "string",
  );
  assertEquals(typeof parseReceivedPayload({ html: "x", meta: { slug: "a" } }), "string");
});
