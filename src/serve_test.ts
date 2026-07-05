import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { join } from "jsr:@std/path@1";
import { makeHandler, serveMain } from "./serve.ts";
import { makeContext } from "./config.ts";

const FIXTURE = `// fixture registry
[
  {
    "num": "§ 01", "id": "tooling",
    "name": "Tooling", "short": "Tooling",
    "docs": [
      { "slug": "alpha", "title": "Alpha", "kind": "Guide", "desc": "first",
        "footLeft": "L", "footRight": "R", "src": "a.html", "visibility": "private" },
      { "slug": "beta", "title": "Beta", "kind": "Guide", "desc": "second",
        "footLeft": "L", "footRight": "R", "src": "b.html", "visibility": "shared", "review": true }
    ]
  }
]
`;

async function fixture(readonly = false) {
  const dir = await Deno.makeTempDir();
  const registryPath = join(dir, "registry.jsonc");
  await Deno.writeTextFile(registryPath, FIXTURE);
  const ctx = await makeContext(dir);
  return {
    registryPath,
    commentsDir: ctx.commentsDir,
    handler: makeHandler({ ctx, readonly }),
  };
}

const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const jsonReq = (path: string, method: string, body: unknown) =>
  req(path, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

Deno.test("PATCH review:true updates the registry text", async () => {
  const f = await fixture();
  const res = await f.handler(jsonReq("/api/docs/alpha", "PATCH", { review: true }));
  assertEquals(res.status, 200);
  const text = await Deno.readTextFile(f.registryPath);
  assert(text.includes(`"review": true`));
  assert(text.startsWith("// fixture registry")); // comments survive
});

Deno.test("PATCH visibility flips the field", async () => {
  const f = await fixture();
  const res = await f.handler(jsonReq("/api/docs/alpha", "PATCH", { visibility: "shared" }));
  assertEquals(res.status, 200);
  interface T {
    docs: Array<{ slug: string; visibility: string }>;
  }
  const corpus = parseJsonc(await Deno.readTextFile(f.registryPath)) as unknown as T[];
  assertEquals(corpus[0].docs.find((d) => d.slug === "alpha")!.visibility, "shared");
});

Deno.test("PATCH unknown slug → 404; bad bodies → 400", async () => {
  const f = await fixture();
  assertEquals((await f.handler(jsonReq("/api/docs/nope", "PATCH", { review: true }))).status, 404);
  assertEquals(
    (await f.handler(jsonReq("/api/docs/alpha", "PATCH", { review: "yes" }))).status,
    400,
  );
  assertEquals((await f.handler(jsonReq("/api/docs/alpha", "PATCH", { bogus: 1 }))).status, 400);
  assertEquals((await f.handler(jsonReq("/api/docs/alpha", "PATCH", {}))).status, 400);
  assertEquals(
    (await f.handler(req("/api/docs/alpha", { method: "PATCH", body: "not json" }))).status,
    400,
  );
});

Deno.test("DELETE deregisters; registry stays valid jsonc", async () => {
  const f = await fixture();
  const res = await f.handler(req("/api/docs/alpha", { method: "DELETE" }));
  assertEquals(res.status, 200);
  const body = await res.json() as { note: string };
  assert(body.note.includes("_migrated"));
  interface T {
    docs: Array<{ slug: string }>;
  }
  const corpus = parseJsonc(await Deno.readTextFile(f.registryPath)) as unknown as T[];
  assertEquals(corpus[0].docs.map((d) => d.slug), ["beta"]);
});

Deno.test("comments: POST → GET → DELETE round-trip", async () => {
  const f = await fixture();
  const input = { quote: "q", prefix: "p", suffix: "s", note: "check this" };
  const post = await f.handler(jsonReq("/api/docs/alpha/comments", "POST", input));
  assertEquals(post.status, 201);
  const created = await post.json() as { id: string };

  const get = await f.handler(req("/api/docs/alpha/comments"));
  assertEquals(get.status, 200);
  const list = await get.json() as Array<{ id: string; note: string }>;
  assertEquals(list.length, 1);
  assertEquals(list[0].note, "check this");

  const del = await f.handler(req(`/api/docs/alpha/comments/${created.id}`, { method: "DELETE" }));
  assertEquals(del.status, 200);
  assertEquals(
    (await f.handler(req(`/api/docs/alpha/comments/${created.id}`, { method: "DELETE" }))).status,
    404,
  );
});

Deno.test("comments: POST to an unregistered slug → 404; bad input → 400", async () => {
  const f = await fixture();
  const input = { quote: "q", prefix: "", suffix: "", note: "n" };
  assertEquals((await f.handler(jsonReq("/api/docs/ghost/comments", "POST", input))).status, 404);
  assertEquals(
    (await f.handler(jsonReq("/api/docs/alpha/comments", "POST", { note: "no quote" }))).status,
    400,
  );
});

Deno.test("READONLY blocks mutations but not reads", async () => {
  const f = await fixture(true);
  assertEquals(
    (await f.handler(jsonReq("/api/docs/alpha", "PATCH", { review: true }))).status,
    403,
  );
  assertEquals((await f.handler(req("/api/docs/alpha", { method: "DELETE" }))).status, 403);
  assertEquals(
    (await f.handler(
      jsonReq("/api/docs/alpha/comments", "POST", {
        quote: "q",
        prefix: "",
        suffix: "",
        note: "n",
      }),
    )).status,
    403,
  );
  assertEquals(
    (await f.handler(req("/api/docs/alpha/comments/some-id", { method: "DELETE" }))).status,
    403,
  );
  assertEquals(
    (await f.handler(jsonReq("/api/docs/alpha/comments/some-id", "PATCH", { reviewed: true })))
      .status,
    403,
  );
  assertEquals((await f.handler(req("/api/docs/alpha/comments"))).status, 200);
});

Deno.test("unknown api path → 404 JSON; wrong method → 405", async () => {
  const f = await fixture();
  assertEquals((await f.handler(req("/api/whatever"))).status, 404);
  assertEquals((await f.handler(req("/api/docs/alpha", { method: "PUT" }))).status, 405);
  assertEquals((await f.handler(req("/api/docs/alpha/comments/xyz"))).status, 405);
});

Deno.test("malformed percent-encoding → 400, JSON shape for api paths", async () => {
  const f = await fixture();
  assertEquals((await f.handler(req("/%zz"))).status, 400);
  const apiRes = await f.handler(req("/api/%zz"));
  assertEquals(apiRes.status, 400);
  assert((apiRes.headers.get("content-type") ?? "").includes("application/json"));
});

Deno.test("served index and api-readonly index both carry the admin context", async () => {
  const f = await fixture();
  const html = await (await f.handler(req("/"))).text();
  assert(html.includes("RR-ADMIN:start"));
  assert(html.includes("window.__RR"));
  assert(html.includes('"page":"index"'));
  assert(html.includes('"alpha"'));

  const ro = await fixture(true);
  const roHtml = await (await ro.handler(req("/"))).text();
  assert(roHtml.includes('"readonly":true'));
});

Deno.test("GET / renders the index from the configured registry", async () => {
  const f = await fixture();
  const res = await f.handler(req("/"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assert(html.includes("Alpha"));
  assert(html.includes("For Review")); // beta carries review: true
});

Deno.test("comments: PATCH reviewed stamps/clears; bad body 400; unknown id 404", async () => {
  const f = await fixture();
  const input = { quote: "q", prefix: "", suffix: "", note: "n" };
  const created = await (await f.handler(jsonReq("/api/docs/alpha/comments", "POST", input)))
    .json() as { id: string };
  const on = await f.handler(jsonReq(`/api/docs/alpha/comments/${created.id}`, "PATCH", {
    reviewed: true,
  }));
  assertEquals(on.status, 200);
  const marked = await on.json() as { reviewed?: string };
  assertEquals(typeof marked.reviewed, "string");
  const off = await f.handler(jsonReq(`/api/docs/alpha/comments/${created.id}`, "PATCH", {
    reviewed: false,
  }));
  assertEquals(off.status, 200);
  assertEquals("reviewed" in (await off.json() as Record<string, unknown>), false);
  assertEquals(
    (await f.handler(jsonReq(`/api/docs/alpha/comments/${created.id}`, "PATCH", {
      reviewed: "yes",
    }))).status,
    400,
  );
  assertEquals(
    (await f.handler(jsonReq("/api/docs/alpha/comments/nope", "PATCH", { reviewed: true })))
      .status,
    404,
  );
});

Deno.test("serveMain is an exported function (server smoke is via makeHandler)", () => {
  assertEquals(typeof serveMain, "function");
});

Deno.test("serveMain returns 1 on an invalid --port without starting a server", async () => {
  assertEquals(await serveMain(["--port", "abc"]), 1);
});

async function tmpCtx() {
  const home = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(home, "registry.jsonc"),
    '[\n  { "num": "§ 01", "id": "t", "name": "T", "short": "T", "docs": [ ' +
      '{ "slug": "a", "title": "A", "kind": "k", "desc": "d", "footLeft": "l", "footRight": "r", "src": "a.html" } ] }\n]\n',
  );
  await Deno.writeTextFile(join(home, "site.jsonc"), '{ "instance": "Test Room" }\n');
  return { ctx: await makeContext(home), cleanup: () => Deno.remove(home, { recursive: true }) };
}

Deno.test("GET /.well-known/reading-room.json returns this instance's identity", async () => {
  const { ctx, cleanup } = await tmpCtx();
  try {
    const h = makeHandler({ ctx, readonly: false });
    const res = await h(new Request("http://localhost/.well-known/reading-room.json"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.topics, 1);
    assertEquals(body.docs, 1);
    assertEquals(typeof body.version, "string");
    assertEquals(body.name, "Test Room");
  } finally {
    await cleanup();
  }
});

Deno.test("well-known identity rejects non-GET", async () => {
  const { ctx, cleanup } = await tmpCtx();
  try {
    const h = makeHandler({ ctx, readonly: false });
    const res = await h(
      new Request("http://localhost/.well-known/reading-room.json", { method: "POST" }),
    );
    assertEquals(res.status, 405);
  } finally {
    await cleanup();
  }
});

Deno.test("GET /api/peers returns the injected discovery result", async () => {
  const { ctx, cleanup } = await tmpCtx();
  try {
    const peers = [{
      name: "studio",
      url: "https://studio.ts.net/",
      identity: { name: "Studio", version: "0.2.0", topics: 2, docs: 5 },
    }];
    const h = makeHandler({ ctx, readonly: false, discover: () => Promise.resolve(peers) });
    const res = await h(new Request("http://localhost/api/peers"));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).peers, peers);
  } finally {
    await cleanup();
  }
});

Deno.test("/api/peers is allowed under READONLY (read-only nav)", async () => {
  const { ctx, cleanup } = await tmpCtx();
  try {
    const h = makeHandler({ ctx, readonly: true, discover: () => Promise.resolve([]) });
    const res = await h(new Request("http://localhost/api/peers"));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).peers, []);
  } finally {
    await cleanup();
  }
});

Deno.test("/api/peers with no discover configured returns an empty list", async () => {
  const { ctx, cleanup } = await tmpCtx();
  try {
    const h = makeHandler({ ctx, readonly: false });
    const res = await h(new Request("http://localhost/api/peers"));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).peers, []);
  } finally {
    await cleanup();
  }
});

Deno.test("/api/peers fails soft to an empty list if discovery rejects", async () => {
  const { ctx, cleanup } = await tmpCtx();
  try {
    const h = makeHandler({
      ctx,
      readonly: false,
      discover: () => Promise.reject(new Error("boom")),
    });
    const res = await h(new Request("http://localhost/api/peers"));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).peers, []);
  } finally {
    await cleanup();
  }
});

Deno.test("served index masthead carries the instance eyebrow tag", async () => {
  const { ctx, cleanup } = await tmpCtx();
  try {
    const h = makeHandler({ ctx, readonly: false });
    const html = await (await h(new Request("http://localhost/"))).text();
    assertStringIncludes(html, "Reference Library · Test Room");
  } finally {
    await cleanup();
  }
});

const XFER_REGISTRY = `[
  { "num": "§ 01", "id": "essays", "name": "Essays", "short": "Essays",
    "docs": [
      { "slug": "alpha", "title": "Alpha", "kind": "Essay", "desc": "First.",
        "footLeft": "2026", "footRight": "src", "src": "home/_migrated/alpha.html", "visibility": "private" }
    ] }
]`;

async function xferRoom(): Promise<Awaited<ReturnType<typeof makeContext>>> {
  const parent = await Deno.makeTempDir();
  const root = join(parent, "home");
  await Deno.mkdir(join(root, "_migrated"), { recursive: true });
  await Deno.writeTextFile(join(root, "registry.jsonc"), XFER_REGISTRY);
  await Deno.writeTextFile(
    join(root, "_migrated", "alpha.html"),
    "<html><body>ALPHA</body></html>",
  );
  return await makeContext(root);
}

async function emptyRoom(): Promise<Awaited<ReturnType<typeof makeContext>>> {
  const parent = await Deno.makeTempDir();
  const root = join(parent, "home");
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(join(root, "registry.jsonc"), "[]");
  return await makeContext(root);
}

Deno.test("POST /api/receive files a doc; READONLY rejects it", async () => {
  const ctx = await emptyRoom();
  const body = JSON.stringify({
    html: "<p>hi</p>",
    meta: {
      slug: "gamma",
      title: "Gamma",
      kind: "Note",
      desc: "",
      footLeft: "L",
      footRight: "R",
      originTopic: "x",
      visibility: "private",
      origin: "Box",
    },
  });
  const ro = makeHandler({ ctx, readonly: true });
  assertEquals(
    (await ro(new Request("http://127.0.0.1/api/receive", { method: "POST", body }))).status,
    403,
  );

  const rw = makeHandler({ ctx, readonly: false });
  const res = await rw(
    new Request("http://127.0.0.1/api/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  assertEquals(res.status, 201);
  assertEquals((await res.json() as { slug: string }).slug, "gamma");
});

Deno.test("send → receive round-trip between two in-memory instances", async () => {
  const sender = await xferRoom();
  const receiver = await emptyRoom();
  const receiverHandler = makeHandler({ ctx: receiver, readonly: false });

  // fake fetch: route the sender's outbound POST straight into the receiver's handler
  const wire = ((url: string | URL | Request, init?: RequestInit) =>
    receiverHandler(
      new Request(String(url), {
        method: init?.method,
        headers: init?.headers,
        body: init?.body as BodyInit,
      }),
    )) as typeof fetch;

  const senderHandler = makeHandler({ ctx: sender, readonly: false, sendFetch: wire });
  const res = await senderHandler(
    new Request("http://127.0.0.1/api/docs/alpha/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "http://127.0.0.1/" }),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json() as { ok: boolean }).ok, true);

  const receiverRegistry = await Deno.readTextFile(receiver.registryPath);
  assertEquals(receiverRegistry.includes(`"id": "received"`), true);
  assertEquals(receiverRegistry.includes(`"review": true`), true);
});

Deno.test("send with a non-string target is 400", async () => {
  const ctx = await xferRoom();
  const h = makeHandler({ ctx, readonly: false });
  const res = await h(
    new Request("http://127.0.0.1/api/docs/alpha/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  assertEquals(res.status, 400);
});
