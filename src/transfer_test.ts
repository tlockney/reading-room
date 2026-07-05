import { assert, assertEquals } from "jsr:@std/assert@1";
import { exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { makeContext } from "./config.ts";
import { loadCorpus } from "./render.ts";
import { buildDocPayload, parseReceivedPayload, receiveDoc, sendDoc } from "./transfer.ts";
import { slugExists } from "./registry-edit.ts";

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

function payload(slug: string, extra: Partial<import("./transfer.ts").DocMeta> = {}) {
  return {
    html: `<html><body>${slug}-body</body></html>`,
    meta: {
      slug,
      title: `T-${slug}`,
      kind: "Guide",
      desc: "Desc.",
      footLeft: "L",
      footRight: "R",
      originTopic: "essays",
      visibility: "private" as const,
      origin: "Laptop",
      ...extra,
    },
  };
}

Deno.test("receiveDoc creates the Received topic, files review:true, appends provenance", async () => {
  const ctx = await room();
  const res = await receiveDoc(ctx, payload("beta"));
  assertEquals(res.slug, "beta");
  assertEquals(res.topic, "received");

  const registry = await Deno.readTextFile(ctx.registryPath);
  assertEquals(slugExists(registry, "beta"), true);
  assertEquals(registry.includes(`"id": "received"`), true);
  assertEquals(registry.includes(`"review": true`), true);
  assertEquals(registry.includes("(received from Laptop)"), true);
  assertEquals(
    await Deno.readTextFile(join(ctx.migratedDir, "beta.html")),
    "<html><body>beta-body</body></html>",
  );
});

Deno.test("receiveDoc sanitizes a hostile slug and dedupes collisions", async () => {
  const ctx = await room();
  await receiveDoc(ctx, payload("dup"));
  const second = await receiveDoc(ctx, payload("dup")); // same slug again
  assertEquals(second.slug, "dup-2"); // deduped, not overwritten

  const hostile = await receiveDoc(ctx, payload("../../etc/passwd"));
  assertEquals(/^[A-Za-z0-9_-]+$/.test(hostile.slug), true); // sanitized to the safe charset
  assertEquals(await exists(join(ctx.migratedDir, `${hostile.slug}.html`)), true);
});

Deno.test("receiveDoc writes the comments sidecar only when comments are present", async () => {
  const ctx = await room();
  const withC = await receiveDoc(ctx, {
    ...payload("annotated"),
    comments: [{
      id: "c1",
      created: "2026-07-05T00:00:00.000Z",
      quote: "q",
      prefix: "",
      suffix: "",
      note: "n",
    }],
  });
  assertEquals(await exists(join(ctx.commentsDir, `${withC.slug}.json`)), true);
  const noC = await receiveDoc(ctx, payload("plain"));
  assertEquals(await exists(join(ctx.commentsDir, `${noC.slug}.json`)), false);
});

Deno.test("sendDoc POSTs the payload to <target>api/receive and returns the peer slug", async () => {
  const ctx = await room();
  const corpus = await loadCorpus(ctx.registryPath);
  let seenUrl = "", seenBody: unknown = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, slug: "alpha" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  const res = await sendDoc(ctx, corpus, "alpha", "https://peer.tail1.ts.net/", {}, fakeFetch);
  assertEquals(res.ok, true);
  assertEquals(res.slug, "alpha");
  assertEquals(seenUrl, "https://peer.tail1.ts.net/api/receive");
  assertEquals((seenBody as { meta: { slug: string } }).meta.slug, "alpha");
});

Deno.test("sendDoc reports a non-2xx peer response as a failure", async () => {
  const ctx = await room();
  const corpus = await loadCorpus(ctx.registryPath);
  const fail = ((_u: string | URL | Request, _i?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "read-only mode" }), { status: 403 }),
    )) as typeof fetch;
  const res = await sendDoc(ctx, corpus, "alpha", "https://peer/", {}, fail);
  assertEquals(res.ok, false);
  assertEquals(res.error, "read-only mode");
});

Deno.test("sendDoc surfaces an unknown local slug as a failure", async () => {
  const ctx = await room();
  const corpus = await loadCorpus(ctx.registryPath);
  const res = await sendDoc(
    ctx,
    corpus,
    "nope",
    "https://peer/",
    {},
    (() => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch,
  );
  assertEquals(res.ok, false);
  assert((res.error ?? "").includes("nope"));
});
