# Reading Room Document Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a curated library doc to another Reading Room instance over the existing tailnet-exposed server APIs — the local server POSTs the doc as JSON to the peer's `/api/receive`, which files it `review: true` into a "Received" topic — driven from the web UI (target picked from the discovery peer list) and a `reading-room send` CLI.

**Architecture:** One serve-only core module (`src/transfer.ts`) builds/parses the JSON payload, files a received doc, and performs the outbound POST (with `fetch` injected for tests). `serve.ts` gains two management routes (`POST /api/docs/<slug>/send`, `POST /api/receive`). The admin UI adds a "Send to" control fed by the existing `/api/peers`; a thin `reading-room send` CLI drives the same send route. No Taildrop, no shell-out.

**Tech Stack:** Deno, TypeScript (strict, no `any`), `@std/fs@1` (`exists`/`ensureDir`), `@std/path@1` (`join`/`basename`), `@std/jsonc@1` (`parse`), `@std/assert@1`. Published to JSR as `@tlockney/reading-room`.

## Global Constraints

Every task's requirements implicitly include these:

- **No `any`.** Narrow untyped input (`readJson` bodies, the received payload) from `unknown` with type guards.
- **Serve-only isolation.** `build.ts`/`render.ts` must never import `transfer.ts`. Pinned by the import-closure walk in `src/admin_test.ts` (extend it in Task 5).
- **No new runtime permissions.** serve already has `--allow-net` (outbound POST), `--allow-read`/`--allow-write`, `--allow-run`. Transfer shells out to nothing. Do not add permission flags.
- **`READONLY=1` gates both routes** (send and receive are management actions). Routing them inside the existing `api()` function inherits this automatically — its first statement returns `403` for any non-`GET` under readonly.
- **Received docs are quarantined:** filed with `review: true` into a reserved topic id `received` (name "Received", num `§ 99`, short "Inbox"), created if absent.
- **Slugs are engine-derived, never taken raw from the payload:** sanitize the incoming slug to `[A-Za-z0-9_-]` and dedupe against the registry (a re-received slug becomes a *new* entry, never an overwrite).
- **Provenance:** append `" (received from <origin>)"` to the received doc's `desc`.
- **Payload wire shape:** `{ html: string, meta: DocMeta, comments?: Comment[] }`; comments present only when sent with `--with-comments`.
- **Commit messages** never mention Claude/AI/automation; no `Claude-Session` trailer.
- **Before every commit:** `deno task test`, `deno fmt --check`, `deno lint` pass. Run `deno fmt` freely (the `fmt.exclude` fence protects pinned content). Run tests with `deno task test <file>` (forwards the repo's `--allow-*` flags) — never a bare `deno test <file>`.
- **After editing anything under `assets/`**, run `deno task gen` and commit the regenerated `src/assets_gen.ts` (the `assets_gen_test.ts` pin fails otherwise).

---

### Task 1: Payload types + build + parse

**Files:**
- Create: `src/transfer.ts`
- Test: `src/transfer_test.ts`

**Interfaces:**
- Consumes: `RoomContext`, `resolveInstanceName` (`./config.ts`); `Topic`, `Doc` (`./render.ts`); `Comment`, `loadComments` (`./comments.ts`); `@std/fs@1` `exists`; `@std/path@1` `join`.
- Produces:
  - `interface DocMeta { slug: string; title: string; kind: string; desc: string; footLeft: string; footRight: string; originTopic: string; visibility: "private" | "shared"; origin: string }`
  - `interface DocPayload { html: string; meta: DocMeta; comments?: Comment[] }`
  - `buildDocPayload(ctx: RoomContext, corpus: Topic[], slug: string, opts: { withComments?: boolean }): Promise<DocPayload>`
  - `parseReceivedPayload(raw: unknown): DocPayload | string`

- [ ] **Step 1: Write the failing test**

```ts
// src/transfer_test.ts
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
  await Deno.writeTextFile(join(root, "_migrated", "alpha.html"), "<html><body>ALPHA</body></html>");
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
      slug: "a", title: "A", kind: "K", desc: "D", footLeft: "L", footRight: "R",
      originTopic: "t", visibility: "private", origin: "Box",
    },
  };
  const parsed = parseReceivedPayload(good);
  assert(typeof parsed !== "string", "good body should parse");
  assertEquals((parsed as { meta: { slug: string } }).meta.slug, "a");

  assertEquals(typeof parseReceivedPayload(null), "string");
  assertEquals(typeof parseReceivedPayload({ html: 1, meta: good.meta }), "string");
  assertEquals(typeof parseReceivedPayload({ html: "x", meta: { ...good.meta, visibility: "bad" } }), "string");
  assertEquals(typeof parseReceivedPayload({ html: "x", meta: { slug: "a" } }), "string");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/transfer_test.ts`
Expected: FAIL — `Module not found` / `transfer.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/transfer.ts
/**
 * Reading Room — peer-to-peer document transfer (serve-only). Send a curated
 * library doc to another Reading Room instance over the tailnet-exposed server
 * APIs: buildDocPayload assembles { html, meta, comments? }; sendDoc POSTs it to
 * a peer's /api/receive; receiveDoc files an incoming payload review:true into a
 * "Received" topic. No Taildrop, no shell-out. build.ts MUST NOT import this
 * module (serve-only, like discovery.ts; pinned in admin_test.ts).
 */
import { exists } from "jsr:@std/fs@1";
import { basename, join } from "jsr:@std/path@1";
import { resolveInstanceName } from "./config.ts";
import type { RoomContext } from "./config.ts";
import type { Doc, Topic } from "./render.ts";
import { loadComments } from "./comments.ts";
import type { Comment } from "./comments.ts";

export interface DocMeta {
  slug: string;
  title: string;
  kind: string;
  desc: string;
  footLeft: string;
  footRight: string;
  originTopic: string; // the sender's topic id — advisory, for the user re-filing
  visibility: "private" | "shared";
  origin: string; // sender instance name
}

export interface DocPayload {
  html: string;
  meta: DocMeta;
  comments?: Comment[];
}

function findDoc(corpus: Topic[], slug: string): { topic: Topic; doc: Doc } | null {
  for (const topic of corpus) {
    for (const doc of topic.docs) if (doc.slug === slug) return { topic, doc };
  }
  return null;
}

export async function buildDocPayload(
  ctx: RoomContext,
  corpus: Topic[],
  slug: string,
  opts: { withComments?: boolean },
): Promise<DocPayload> {
  const found = findDoc(corpus, slug);
  if (!found) throw new Error(`unknown slug: ${slug}`);
  const override = join(ctx.migratedDir, `${slug}.html`);
  const html = await exists(override)
    ? await Deno.readTextFile(override)
    : await Deno.readTextFile(join(ctx.workspace, found.doc.src));
  const payload: DocPayload = {
    html,
    meta: {
      slug: found.doc.slug,
      title: found.doc.title,
      kind: found.doc.kind,
      desc: found.doc.desc,
      footLeft: found.doc.footLeft,
      footRight: found.doc.footRight,
      originTopic: found.topic.id,
      visibility: found.doc.visibility ?? "private",
      origin: resolveInstanceName(ctx.site),
    },
  };
  if (opts.withComments) {
    const comments = await loadComments(ctx.commentsDir, slug);
    if (comments.length) payload.comments = comments;
  }
  return payload;
}

function parseMeta(raw: unknown): DocMeta | string {
  if (typeof raw !== "object" || raw === null) return "meta must be an object";
  const o = raw as Record<string, unknown>;
  for (const k of ["slug", "title", "kind", "desc", "footLeft", "footRight", "originTopic", "origin"] as const) {
    if (typeof o[k] !== "string") return `meta.${k} must be a string`;
  }
  if (o.visibility !== "private" && o.visibility !== "shared") {
    return 'meta.visibility must be "private" or "shared"';
  }
  return {
    slug: o.slug as string,
    title: o.title as string,
    kind: o.kind as string,
    desc: o.desc as string,
    footLeft: o.footLeft as string,
    footRight: o.footRight as string,
    originTopic: o.originTopic as string,
    visibility: o.visibility,
    origin: o.origin as string,
  };
}

export function parseReceivedPayload(raw: unknown): DocPayload | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const o = raw as Record<string, unknown>;
  if (typeof o.html !== "string") return "html must be a string";
  const meta = parseMeta(o.meta);
  if (typeof meta === "string") return meta;
  const payload: DocPayload = { html: o.html, meta };
  if (o.comments !== undefined) {
    if (!Array.isArray(o.comments)) return "comments must be an array";
    payload.comments = o.comments as Comment[];
  }
  return payload;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test src/transfer_test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/transfer.ts src/transfer_test.ts && deno lint src/transfer.ts
git add src/transfer.ts src/transfer_test.ts
git commit -m "feat(transfer): doc payload build + parse"
```

---

### Task 2: receiveDoc (file an incoming payload)

**Files:**
- Modify: `src/transfer.ts`
- Test: `src/transfer_test.ts`

**Interfaces:**
- Consumes: Task 1 exports; `insertDoc`, `insertTopic`, `slugExists` (`./registry-edit.ts`); `writeAtomic` (`./comments.ts`); `@std/fs@1` `ensureDir`; `@std/path@1` `basename`/`join`; `@std/jsonc@1` `parse`.
- Produces: `receiveDoc(ctx: RoomContext, payload: DocPayload): Promise<{ slug: string; topic: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/transfer_test.ts
import { receiveDoc } from "./transfer.ts";
import { slugExists } from "./registry-edit.ts";

function payload(slug: string, extra: Partial<import("./transfer.ts").DocMeta> = {}) {
  return {
    html: `<html><body>${slug}-body</body></html>`,
    meta: {
      slug, title: `T-${slug}`, kind: "Guide", desc: "Desc.",
      footLeft: "L", footRight: "R", originTopic: "essays", visibility: "private" as const,
      origin: "Laptop", ...extra,
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
  assertEquals(await Deno.readTextFile(join(ctx.migratedDir, "beta.html")), "<html><body>beta-body</body></html>");
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
  const withC = await receiveDoc(ctx, { ...payload("annotated"), comments: [{
    id: "c1", created: "2026-07-05T00:00:00.000Z", quote: "q", prefix: "", suffix: "", note: "n",
  }] });
  assertEquals(await exists(join(ctx.commentsDir, `${withC.slug}.json`)), true);
  const noC = await receiveDoc(ctx, payload("plain"));
  assertEquals(await exists(join(ctx.commentsDir, `${noC.slug}.json`)), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/transfer_test.ts`
Expected: FAIL — `receiveDoc is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/transfer.ts
import { ensureDir } from "jsr:@std/fs@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { insertDoc, insertTopic, slugExists } from "./registry-edit.ts";
import type { DocEntry } from "./registry-edit.ts";
import { writeAtomic } from "./comments.ts";

/** A safe, unique slug: strip to the route charset, fall back if empty, then
 * suffix -2, -3, … until it clears the registry. Never trusts the raw slug. */
function safeUniqueSlug(registry: string, raw: string): string {
  const base = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") ||
    "received-doc";
  let slug = base;
  for (let n = 2; slugExists(registry, slug); n++) slug = `${base}-${n}`;
  return slug;
}

function topicExists(registry: string, id: string): boolean {
  const corpus = parseJsonc(registry) as unknown as Array<{ id?: unknown }>;
  return Array.isArray(corpus) && corpus.some((t) => t?.id === id);
}

export async function receiveDoc(
  ctx: RoomContext,
  payload: DocPayload,
): Promise<{ slug: string; topic: string }> {
  const registry = await Deno.readTextFile(ctx.registryPath);
  const slug = safeUniqueSlug(registry, payload.meta.slug);

  await ensureDir(ctx.migratedDir);
  await Deno.writeTextFile(join(ctx.migratedDir, `${slug}.html`), payload.html);
  if (payload.comments && payload.comments.length) {
    await ensureDir(ctx.commentsDir);
    await writeAtomic(
      join(ctx.commentsDir, `${slug}.json`),
      JSON.stringify(payload.comments, null, 2) + "\n",
    );
  }

  const m = payload.meta;
  const entry: DocEntry = {
    slug,
    title: m.title,
    kind: m.kind,
    desc: m.desc ? `${m.desc} (received from ${m.origin})` : `Received from ${m.origin}`,
    footLeft: m.footLeft,
    footRight: m.footRight,
    src: `${basename(ctx.root)}/_migrated/${slug}.html`,
    visibility: m.visibility,
    review: true,
  };
  const next = topicExists(registry, "received")
    ? insertDoc(registry, "received", entry)
    : insertTopic(registry, { num: "§ 99", id: "received", name: "Received", short: "Inbox", docs: [entry] });
  await writeAtomic(ctx.registryPath, next);
  return { slug, topic: "received" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test src/transfer_test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/transfer.ts src/transfer_test.ts && deno lint src/transfer.ts
git add src/transfer.ts src/transfer_test.ts
git commit -m "feat(transfer): file a received doc into the Received topic"
```

---

### Task 3: sendDoc (outbound POST)

**Files:**
- Modify: `src/transfer.ts`
- Test: `src/transfer_test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `sendDoc(ctx: RoomContext, corpus: Topic[], slug: string, target: string, opts: { withComments?: boolean }, fetchFn?: typeof fetch): Promise<{ ok: boolean; slug?: string; error?: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/transfer_test.ts
import { sendDoc } from "./transfer.ts";

Deno.test("sendDoc POSTs the payload to <target>api/receive and returns the peer slug", async () => {
  const ctx = await room();
  const corpus = await loadCorpus(ctx.registryPath);
  let seenUrl = "", seenBody: unknown = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(JSON.stringify({ ok: true, slug: "alpha" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
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
    Promise.resolve(new Response(JSON.stringify({ error: "read-only mode" }), { status: 403 }))) as typeof fetch;
  const res = await sendDoc(ctx, corpus, "alpha", "https://peer/", {}, fail);
  assertEquals(res.ok, false);
  assertEquals(res.error, "read-only mode");
});

Deno.test("sendDoc surfaces an unknown local slug as a failure", async () => {
  const ctx = await room();
  const corpus = await loadCorpus(ctx.registryPath);
  const res = await sendDoc(ctx, corpus, "nope", "https://peer/", {}, (() => {
    throw new Error("should not fetch");
  }) as unknown as typeof fetch);
  assertEquals(res.ok, false);
  assert((res.error ?? "").includes("nope"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/transfer_test.ts`
Expected: FAIL — `sendDoc is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/transfer.ts
export async function sendDoc(
  ctx: RoomContext,
  corpus: Topic[],
  slug: string,
  target: string,
  opts: { withComments?: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; slug?: string; error?: string }> {
  let payload: DocPayload;
  try {
    payload = await buildDocPayload(ctx, corpus, slug, opts);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let url: string;
  try {
    url = new URL("api/receive", target).href;
  } catch {
    return { ok: false, error: `invalid target: ${target}` };
  }
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch { /* keep status */ }
      return { ok: false, error: msg };
    }
    const body = (await res.json()) as { slug?: string };
    return { ok: true, slug: body.slug };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

> Note: `new URL("api/receive", target)` requires `target` to be a base URL ending in `/` (the
> discovery peer `url` is `https://host.tailnet.ts.net/`), so it resolves to `…/api/receive`.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test src/transfer_test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/transfer.ts src/transfer_test.ts && deno lint src/transfer.ts
git add src/transfer.ts src/transfer_test.ts
git commit -m "feat(transfer): sendDoc outbound POST to a peer"
```

---

### Task 4: Serve routes (send + receive) + round-trip

**Files:**
- Modify: `src/serve.ts`
- Test: `src/serve_test.ts`

**Interfaces:**
- Consumes: `sendDoc`, `receiveDoc`, `parseReceivedPayload` (`./transfer.ts`); `loadCorpus` (already imported in serve.ts); existing serve helpers `json`/`jsonError`/`readJson`/`NOT_JSON`.
- Produces:
  - `ServeOptions.sendFetch?: typeof fetch` (injected; falls through to `sendDoc`'s default).
  - Routes inside `api()`: `POST /api/docs/<slug>/send { target, withComments? }` and `POST /api/receive`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/serve_test.ts — reuse the file's existing temp-room + makeHandler harness.
// If not already imported there, add: makeContext (./config.ts), makeHandler (./serve.ts),
// join (jsr:@std/path@1), loadCorpus (./render.ts).
import { receiveDoc } from "./transfer.ts";

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
  await Deno.writeTextFile(join(root, "_migrated", "alpha.html"), "<html><body>ALPHA</body></html>");
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
      slug: "gamma", title: "Gamma", kind: "Note", desc: "", footLeft: "L", footRight: "R",
      originTopic: "x", visibility: "private", origin: "Box",
    },
  });
  const ro = makeHandler({ ctx, readonly: true });
  assertEquals((await ro(new Request("http://127.0.0.1/api/receive", { method: "POST", body }))).status, 403);

  const rw = makeHandler({ ctx, readonly: false });
  const res = await rw(new Request("http://127.0.0.1/api/receive", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  assertEquals(res.status, 201);
  assertEquals((await res.json() as { slug: string }).slug, "gamma");
});

Deno.test("send → receive round-trip between two in-memory instances", async () => {
  const sender = await xferRoom();
  const receiver = await emptyRoom();
  const receiverHandler = makeHandler({ ctx: receiver, readonly: false });

  // fake fetch: route the sender's outbound POST straight into the receiver's handler
  const wire = ((url: string | URL | Request, init?: RequestInit) =>
    receiverHandler(new Request(String(url), {
      method: init?.method, headers: init?.headers, body: init?.body as BodyInit,
    }))) as typeof fetch;

  const senderHandler = makeHandler({ ctx: sender, readonly: false, sendFetch: wire });
  const res = await senderHandler(new Request("http://127.0.0.1/api/docs/alpha/send", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "http://127.0.0.1/" }),
  }));
  assertEquals(res.status, 200);
  assertEquals((await res.json() as { ok: boolean }).ok, true);

  const receiverRegistry = await Deno.readTextFile(receiver.registryPath);
  assertEquals(receiverRegistry.includes(`"id": "received"`), true);
  assertEquals(receiverRegistry.includes(`"review": true`), true);
});

Deno.test("send with a non-string target is 400", async () => {
  const ctx = await xferRoom();
  const h = makeHandler({ ctx, readonly: false });
  const res = await h(new Request("http://127.0.0.1/api/docs/alpha/send", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  }));
  assertEquals(res.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test src/serve_test.ts`
Expected: FAIL — `/api/receive` and `/api/docs/alpha/send` return `not found` / `method not allowed`.

- [ ] **Step 3: Implement**

In `src/serve.ts`, add the import and the `ServeOptions` field, a route regex, and the dispatch.

```ts
// with the other imports:
import { parseReceivedPayload, receiveDoc, sendDoc } from "./transfer.ts";
```

```ts
// add to ServeOptions:
  sendFetch?: typeof fetch; // injected in tests; prod uses sendDoc's default fetch
```

```ts
// add near the other route regexes (top of file):
const API_DOC_SEND_RE = /^\/api\/docs\/([A-Za-z0-9_-]+)\/send$/;
```

Inside `api()`, before the final `return jsonError("not found", 404);`:

```ts
    const sendMatch = path.match(API_DOC_SEND_RE);
    if (sendMatch) {
      if (req.method !== "POST") return jsonError("method not allowed", 405);
      const raw = await readJson(req);
      if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
      if (typeof raw !== "object" || raw === null) return jsonError("body must be a JSON object", 400);
      const o = raw as Record<string, unknown>;
      if (typeof o.target !== "string") return jsonError("target must be a string", 400);
      const corpus = await loadCorpus(opts.ctx.registryPath);
      const result = await sendDoc(
        opts.ctx,
        corpus,
        sendMatch[1],
        o.target,
        { withComments: o.withComments === true },
        opts.sendFetch,
      );
      return result.ok ? json(result) : jsonError(result.error ?? "send failed", 502);
    }

    if (path === "/api/receive") {
      if (req.method !== "POST") return jsonError("method not allowed", 405);
      const raw = await readJson(req);
      if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
      const payload = parseReceivedPayload(raw);
      if (typeof payload === "string") return jsonError(payload, 400);
      const filed = await receiveDoc(opts.ctx, payload);
      return json({ ok: true, slug: filed.slug }, 201);
    }
```

No change to `serveMain` is required — `opts.sendFetch` is undefined in production, so `sendDoc`'s `fetchFn = fetch` default applies.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test src/serve_test.ts` then the full suite `deno task test`
Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/serve.ts src/serve_test.ts && deno lint src/serve.ts
git add src/serve.ts src/serve_test.ts
git commit -m "feat(transfer): /api/docs/<slug>/send and /api/receive routes"
```

---

### Task 5: Build-purity pin + public exports

**Files:**
- Modify: `src/admin_test.ts`
- Modify: `src/mod.ts`

**Interfaces:**
- Produces: `mod.ts` re-exports `buildDocPayload`, `parseReceivedPayload`, `receiveDoc`, `sendDoc` and `type { DocMeta, DocPayload }` from `./transfer.ts`.

- [ ] **Step 1: Extend the build-purity test**

In `src/admin_test.ts`, in the "static build path's import closure" test, after the `discovery.ts` assertion add:

```ts
  assert(!seen.has("transfer.ts"), "build path must not import transfer.ts");
```

- [ ] **Step 2: Run it (expect PASS already — regression guard)**

Run: `deno task test src/admin_test.ts`
Expected: PASS (nothing in the build path imports `transfer.ts`). If it FAILS, an earlier task wrongly routed transfer through the build path — fix that import before continuing.

- [ ] **Step 3: Add the exports**

In `src/mod.ts`, append:

```ts
export { buildDocPayload, parseReceivedPayload, receiveDoc, sendDoc } from "./transfer.ts";
export type { DocMeta, DocPayload } from "./transfer.ts";
```

- [ ] **Step 4: Run the full suite**

Run: `deno task test`
Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/mod.ts src/admin_test.ts && deno lint src/mod.ts
git add src/mod.ts src/admin_test.ts
git commit -m "feat(transfer): pin build-purity and export public surface"
```

---

### Task 6: `reading-room send` CLI

**Files:**
- Create: `src/transfer-cli.ts`
- Create: `src/transfer-cli_test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces:
  - `resolvePort(flag: string | undefined, env: string | undefined): number`
  - `matchPeer(peers: Array<{ url: string; name?: string; identity?: { name?: string } }>, needle: string): string | null` — returns the target URL for a peer named `needle` (by identity name, bare name, or url), or `null`.
  - `sendMain(args: string[]): Promise<number>`

- [ ] **Step 1: Write the failing test**

```ts
// src/transfer-cli_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { matchPeer, resolvePort } from "./transfer-cli.ts";

Deno.test("resolvePort: flag > $PORT > 8413", () => {
  assertEquals(resolvePort("9000", undefined), 9000);
  assertEquals(resolvePort(undefined, "7000"), 7000);
  assertEquals(resolvePort(undefined, undefined), 8413);
  assertEquals(resolvePort(undefined, "junk"), 8413);
});

Deno.test("matchPeer resolves by identity name, bare name, or url", () => {
  const peers = [
    { url: "https://studio.t.ts.net/", name: "studio", identity: { name: "Studio" } },
    { url: "https://box.t.ts.net/", name: "box" },
  ];
  assertEquals(matchPeer(peers, "Studio"), "https://studio.t.ts.net/");
  assertEquals(matchPeer(peers, "box"), "https://box.t.ts.net/");
  assertEquals(matchPeer(peers, "https://box.t.ts.net/"), "https://box.t.ts.net/");
  assertEquals(matchPeer(peers, "nope"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/transfer-cli_test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/transfer-cli.ts
/**
 * `reading-room send <slug> <peer>` — send a library doc to another Reading
 * Room instance by driving the local server's /api/docs/<slug>/send route over
 * 127.0.0.1 (the server, not this CLI, reaches the peer). The peer is resolved
 * from the local server's /api/peers (discovery) by name, or passed as a URL.
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";

interface PeerLike {
  url: string;
  name?: string;
  identity?: { name?: string };
}

export function resolvePort(flag: string | undefined, env: string | undefined): number {
  const raw = flag ?? env ?? "8413";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8413;
}

/** Target URL for the peer named `needle` (identity name, bare name, or an
 * exact url), or null when nothing matches. */
export function matchPeer(peers: PeerLike[], needle: string): string | null {
  if (/^https?:\/\//.test(needle)) return needle;
  for (const p of peers) {
    if (p.identity?.name === needle || p.name === needle || p.url === needle) return p.url;
  }
  return null;
}

export async function sendMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["port"], boolean: ["with-comments"] });
  const [slug, peer] = a._.map(String);
  if (!slug || !peer) {
    console.error("usage: reading-room send <slug> <peer> [--with-comments] [--port N]");
    return 1;
  }
  const port = resolvePort(a.port, Deno.env.get("PORT"));
  const base = `http://127.0.0.1:${port}`;

  let peers: PeerLike[];
  try {
    const res = await fetch(`${base}/api/peers`);
    peers = ((await res.json()) as { peers?: PeerLike[] }).peers ?? [];
  } catch {
    console.error(`reading-room: no running Reading Room agent on :${port} — is it installed?`);
    return 1;
  }
  const target = matchPeer(peers, peer);
  if (!target) {
    console.error(`reading-room: no such peer "${peer}" (try: reading-room send ${slug} <url>)`);
    return 1;
  }

  const res = await fetch(`${base}/api/docs/${slug}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, withComments: a["with-comments"] === true }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`reading-room: ${res.status} ${text}`);
    return 1;
  }
  console.log(text);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await sendMain(Deno.args));
}
```

In `src/cli.ts`, add the import and a case:

```ts
// import:
import { sendMain } from "./transfer-cli.ts";
// case, after add-doc:
      case "send":
        return await sendMain(rest);
```

And a usage line under Commands in `USAGE`:

```
  send      <slug> <peer> [--with-comments]   Send a doc to another RR instance
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test src/transfer-cli_test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/transfer-cli.ts src/transfer-cli_test.ts src/cli.ts && deno lint src/transfer-cli.ts src/cli.ts
git add src/transfer-cli.ts src/transfer-cli_test.ts src/cli.ts
git commit -m "feat(transfer): reading-room send CLI"
```

---

### Task 7: Admin UI — "Send to" control

**Files:**
- Modify: `assets/admin/admin.js`
- Modify: `assets/admin/admin.css`
- Modify (generated): `src/assets_gen.ts` (via `deno task gen` — do not hand-edit)

**Interfaces:** none (browser UI; behavior covered by the Task 4 route tests).

- [ ] **Step 1: Add the send control to manage mode**

In `assets/admin/admin.js`, the index manage mode builds per-card controls. Make the mode fetch the
peer list once when it turns on, and pass it to `addControls`.

Change the `setMode` body's enable branch (currently
`if (on) document.querySelectorAll("a.card").forEach(addControls);`) to:

```js
    if (on) {
      let peers = [];
      try {
        peers = (await api("GET", "/api/peers")).peers || [];
      } catch (_) { /* no peers → no send control */ }
      document.querySelectorAll("a.card").forEach((card) => addControls(card, peers));
    }
```

and make `setMode` async: `async function setMode(next) {`.

Then change `function addControls(card) {` to `function addControls(card, peers) {` and, just before
`row.append(review, vis, remove);`, add a peer-picker `<select>` (only when peers exist):

```js
    if (peers && peers.length) {
      const send = el("select", "rradmin-send");
      const ph = el("option", null, "send ▸");
      ph.value = "";
      send.appendChild(ph);
      for (const p of peers) {
        const opt = el("option", null, (p.identity && p.identity.name) || p.name || p.url);
        opt.value = p.url;
        send.appendChild(opt);
      }
      send.addEventListener("change", () => {
        if (!send.value) return;
        const target = send.value;
        const label = send.options[send.selectedIndex].textContent;
        send.value = ""; // reset the picker; sending doesn't reload (local library is unchanged)
        api("POST", `/api/docs/${slug}/send`, { target })
          .then((r) => toast(`sent to ${label}` + (r && r.slug ? ` (${r.slug})` : "")))
          .catch((err) => toast(`send failed: ${err.message}`));
      });
      row.append(send);
    }
```

(`row.append(review, vis, remove);` stays; the select is appended alongside.)

- [ ] **Step 2: Style the control**

In `assets/admin/admin.css`, append a rule matching the existing `.rradmin-controls button`
treatment so the select fits the row:

```css
.rradmin-send {
  appearance: none;
  background: transparent;
  border: 1px solid var(--rule-strong, #8a7e5e);
  border-radius: 2px;
  color: var(--ink-soft, #3a3a36);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 4px 9px;
  cursor: pointer;
}
.rradmin-send:hover {
  color: var(--copper, #a85a1a);
  border-color: var(--copper, #a85a1a);
}
```

- [ ] **Step 3: Regenerate the embedded asset bundle**

The engine embeds `assets/` as string constants in `src/assets_gen.ts` (JSR can't read files at
runtime). Regenerate and confirm the pin:

Run: `deno task gen && deno task test src/assets_gen_test.ts`
Expected: `assets_gen.ts` updated; the pin test PASSES (generated ↔ source in sync).

- [ ] **Step 4: Full suite + fmt + lint**

Run: `deno task test && deno fmt --check && deno lint`
Expected: all PASS. (If `deno fmt --check` flags `src/assets_gen.ts`, run `deno task gen` did not
format it — run `deno fmt src/assets_gen.ts` and re-run `deno task gen` to confirm it stays stable.)

- [ ] **Step 5: Commit**

```bash
git add assets/admin/admin.js assets/admin/admin.css src/assets_gen.ts
git commit -m "feat(transfer): Send-to control in manage mode"
```

---

### Task 8: Docs + full-suite green

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Add a section after "Peer discovery (serve-only)":

```markdown
## Document transfer (serve-only)

Send a curated doc to another Reading Room instance over the tailnet-exposed server APIs (no
Taildrop). `src/transfer.ts` builds a JSON payload (`{ html, meta, comments? }`), `sendDoc` POSTs it
to a peer's `POST /api/receive`, and `receiveDoc` files it `review: true` into a reserved "Received"
topic (id `received`), sanitizing + deduping the slug (never trusting the payload's raw slug) and
appending provenance to `desc`. Driven from the admin "Send to" control (target from `/api/peers`,
the same discovery list as the library switcher) and the `reading-room send <slug> <peer>` CLI.
Both routes are serve-only and READONLY-gated; the outbound `fetch` is injected in tests
(`ServeOptions.sendFetch`), so the round-trip suite needs no network. `build.ts` must never import
`src/transfer.ts` (pinned in `admin_test.ts`). Security: `POST /api/receive` is a new inbound write
reachable by any tailnet member — mitigated by review-quarantine + READONLY. See
`_specs/2026-07-05-doc-transfer-design.md`.
```

- [ ] **Step 2: Update `README.md`**

Near the `reading-room` subcommand docs, add (matching the README's heading style):

```markdown
### Sending a doc to another instance

Push a curated doc to another of your Reading Room libraries over the tailnet:

    reading-room send <slug> <peer>       # peer = a discovered library's name, or its URL
    reading-room send <slug> <peer> --with-comments

It arrives quarantined (`review: true`) in the peer's "Received" topic for you to vet and re-file.
In the browser, use the "send ▸" control in § Manage mode; the target list is the same peer
discovery that powers the library switcher.
```

- [ ] **Step 3: Full verification gate**

Run:
```bash
deno task test
deno fmt --check
deno lint
deno publish --dry-run
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(transfer): document peer-to-peer document transfer"
```

- [ ] **Step 5: Manual smoke test (record results, do not automate)**

Two instances on one tailnet (or fake the second with a temp home + a second `serve` port):
```bash
reading-room serve 8413 &     # instance A (has a doc)
reading-room serve 8414 --root /tmp/roomB &   # instance B (empty)
# From A's UI: § Manage → pick B in "send ▸" on a card, or:
curl -s -XPOST http://127.0.0.1:8413/api/docs/<slug>/send \
  -H 'content-type: application/json' -d '{"target":"http://127.0.0.1:8414/"}'
curl -s http://127.0.0.1:8414/            # B's index shows the doc in "For Review" / "Received"
```
Expected: the doc appears in B's Received topic, flagged for review.

---

## Rollout (after the plan is complete — separate from the code commits)

1. Bump `version` in `deno.jsonc`; commit; tag `v<version>`; push (CI publishes to JSR).
2. Per machine: re-run the `deno install -g -f … jsr:@tlockney/reading-room/cli` line at the new
   version. The launchd agent picks it up on next start.
3. Independent of the 2026-07-04 artifact store — no ordering dependency.

## Notes for the implementer

- `deno task test <file>` runs the repo's test task (`deno test --allow-read --allow-write
  --allow-env`) scoped to a file — Deno forwards the trailing path. Never use a bare `deno test`.
- `src/serve_test.ts` already builds a `RoomContext` over a temp dir and calls `makeHandler`; reuse
  that harness and add any missing imports the Task 4 snippet references.
- Do not touch the `deno.jsonc` `fmt.exclude` fence. `src/assets_gen.ts` is generated — only ever
  change it via `deno task gen`.
- The `Doc` type (`render.ts`) carries `slug/title/kind/desc/footLeft/footRight/src/review?` and an
  optional `visibility`; `buildDocPayload` defaults `visibility` to `"private"` when absent.
```
