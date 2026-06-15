# Peer Discovery & Cross-Instance Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each Reading Room instance advertises itself at `GET /.well-known/reading-room.json` and
discovers peers by enumerating the tailnet (+ optional `seeds`) and probing that endpoint; a
serve-only masthead switcher lets the user navigate between live instances. No replicated peer-list
file.

**Architecture:** A new serve-only `src/discovery.ts` (dependency-injected for tests) parses
`tailscale status --json`, probes each candidate's well-known endpoint, and returns live peers.
`serve.ts` gains two routes (`/.well-known/reading-room.json`, `/api/peers`) and an injectable
`discover`. The admin layer (`assets/admin/`) renders a switcher from `/api/peers`. `build.ts` must
not import discovery (serve-only, like `admin.ts`).

**Tech Stack:** Deno 2.x, TypeScript (no `any`), JSR std, `deno test`. Tests are colocated as
`src/<name>_test.ts` and run with `deno test --allow-read --allow-write --allow-env --allow-run`.

**Reference spec:** `_specs/2026-06-14-peer-discovery-design.md`.

**Conventions:** Never use `any`; smallest reasonable changes; match surrounding style; never
mention AI/Claude in commit messages. Run `deno fmt`/`deno lint` before each commit. Exported
functions need explicit return types (JSR slow-types).

---

## Task ordering

- **T1** config `seeds` (leaf) → **T2** `discovery.ts` (needs config/render types) → **T3** serve
  routes (needs T2) → **T4** build-purity guard (needs T2) → **T5** switcher assets (needs T3 at
  runtime) → **T6** `deno.jsonc` perms → **T7** docs. Sequential; do not run implementers in
  parallel (commit races).

---

## Task 1: optional `seeds` on `Site`

**Files:** Modify `src/config.ts`; Test `src/config_test.ts`.

- [ ] **Step 1: Failing tests** — append to `src/config_test.ts`:

```ts
Deno.test("parseSite accepts a seeds array", () => {
  const s = parseSite({ seeds: ["https://a.ts.net/", "https://b.ts.net/"] });
  assertEquals(typeof s === "string" ? s : s.seeds, ["https://a.ts.net/", "https://b.ts.net/"]);
});

Deno.test("parseSite rejects non-string seeds", () => {
  assertEquals(parseSite({ seeds: [1, 2] }), "seeds must be an array of strings");
});
```

(`parseSite` and `assertEquals` are already imported in this file — do not duplicate.)

- [ ] **Step 2: Run — expect FAIL**

Run: `deno test --allow-read --allow-write --allow-env src/config_test.ts` Expected: FAIL — `seeds`
is rejected as `unknown field`.

- [ ] **Step 3: Implement.** In `src/config.ts`, add `seeds` to the `Site` interface (after
      `footer`):

```ts
export interface Site {
  title: string;
  eyebrow: string;
  lede: string;
  footer: string[];
  seeds?: string[]; // optional discovery escape-hatch: base URLs of peers the auto-sources can't see
}
```

In `parseSite`, add a branch before the `else` that returns `unknown field` (i.e., make `seeds` a
recognized key):

```ts
} else if (key === "footer") {
  if (!isStringArray(o.footer)) return "footer must be an array of strings";
  site.footer = o.footer;
} else if (key === "seeds") {
  if (!isStringArray(o.seeds)) return "seeds must be an array of strings";
  site.seeds = o.seeds;
} else {
  return `unknown field: ${key}`;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `deno test --allow-read --allow-write --allow-env src/config_test.ts` Expected: PASS (new +
existing).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/config.ts src/config_test.ts && deno lint src/config.ts src/config_test.ts
git add src/config.ts src/config_test.ts
git commit -m "feat(config): optional site.jsonc seeds for peer discovery"
```

---

## Task 2: `src/discovery.ts` (serve-only, dependency-injected)

**Files:** Create `src/discovery.ts`; Test `src/discovery_test.ts`.

- [ ] **Step 1: Failing tests** — create `src/discovery_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildIdentity,
  discoverPeers,
  makeCachedDiscover,
  parseTailscalePeers,
  type PeerIdentity,
  probePeer,
  type TailscalePeer,
} from "./discovery.ts";
import type { Topic } from "./render.ts";
import { DEFAULT_SITE } from "./config.ts";

const STATUS = {
  Self: { HostName: "laptop", DNSName: "laptop.tail-scale.ts.net.", Online: true },
  Peer: {
    "key1": { HostName: "studio", DNSName: "studio.tail-scale.ts.net.", Online: true },
    "key2": { HostName: "nas", DNSName: "nas.tail-scale.ts.net.", Online: false },
    "key3": { HostName: "noDns" }, // missing DNSName → skipped
  },
};

Deno.test("parseTailscalePeers maps Peer entries, strips trailing dot, excludes self", () => {
  const peers = parseTailscalePeers(STATUS);
  assertEquals(peers.length, 2);
  assertEquals(peers[0], { name: "studio", dnsName: "studio.tail-scale.ts.net", online: true });
  assertEquals(peers[1].online, false);
});

Deno.test("parseTailscalePeers tolerates junk", () => {
  assertEquals(parseTailscalePeers({}), []);
  assertEquals(parseTailscalePeers(null), []);
  assertEquals(parseTailscalePeers({ Peer: 5 }), []);
});

Deno.test("buildIdentity counts topics and docs", () => {
  const corpus: Topic[] = [
    { num: "1", id: "a", name: "A", short: "A", docs: [{ slug: "x" } as Topic["docs"][number]] },
    {
      num: "2",
      id: "b",
      name: "B",
      short: "B",
      docs: [{ slug: "y" }, { slug: "z" }] as Topic["docs"],
    },
  ];
  assertEquals(buildIdentity(DEFAULT_SITE, corpus, "9.9.9"), {
    title: DEFAULT_SITE.title,
    version: "9.9.9",
    topics: 2,
    docs: 3,
  });
});

Deno.test("probePeer returns identity on a valid response, null otherwise", async () => {
  const good: PeerIdentity = { title: "Studio", version: "0.2.0", topics: 2, docs: 5 };
  const okFetch =
    ((_u: string | URL | Request) =>
      Promise.resolve(new Response(JSON.stringify(good)))) as typeof fetch;
  assertEquals(await probePeer("https://studio.ts.net/", okFetch), good);

  const notFound = (() => Promise.resolve(new Response("no", { status: 404 }))) as typeof fetch;
  assertEquals(await probePeer("https://studio.ts.net/", notFound), null);

  const garbage = (() => Promise.resolve(new Response("not json"))) as typeof fetch;
  assertEquals(await probePeer("https://studio.ts.net/", garbage), null);

  const boom = (() => Promise.reject(new Error("refused"))) as typeof fetch;
  assertEquals(await probePeer("https://studio.ts.net/", boom), null);
});

Deno.test("discoverPeers unions tailnet+seeds, dedupes, drops non-answering", async () => {
  const listPeers = (): Promise<TailscalePeer[]> =>
    Promise.resolve([
      { name: "studio", dnsName: "studio.ts.net", online: true },
      { name: "nas", dnsName: "nas.ts.net", online: false }, // offline → not probed
    ]);
  const idents: Record<string, PeerIdentity> = {
    "https://studio.ts.net/": { title: "Studio", version: "0.2.0", topics: 1, docs: 1 },
    "https://seed.ts.net/": { title: "Seed", version: "0.2.0", topics: 0, docs: 0 },
  };
  const probe = (url: string): Promise<PeerIdentity | null> => Promise.resolve(idents[url] ?? null);

  const peers = await discoverPeers({
    listPeers,
    probe,
    seeds: ["https://seed.ts.net/", "https://studio.ts.net/"], // dup of tailnet url
  });
  const urls = peers.map((p) => p.url).sort();
  assertEquals(urls, ["https://seed.ts.net/", "https://studio.ts.net/"]);
});

Deno.test("makeCachedDiscover serves from cache within TTL", async () => {
  let calls = 0;
  const listPeers = (): Promise<TailscalePeer[]> => {
    calls++;
    return Promise.resolve([{ name: "s", dnsName: "s.ts.net", online: true }]);
  };
  const probe = (): Promise<PeerIdentity | null> =>
    Promise.resolve({ title: "S", version: "0.2.0", topics: 0, docs: 0 });
  const discover = makeCachedDiscover({ listPeers, probe }, 30_000);
  await discover();
  await discover();
  assertEquals(calls, 1); // second call hit the cache
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `deno test --allow-read --allow-write --allow-env src/discovery_test.ts` Expected: FAIL —
`./discovery.ts` does not exist.

- [ ] **Step 3: Implement `src/discovery.ts`:**

```ts
/**
 * Reading Room — peer discovery (serve-only). The tailnet is the membership
 * source: enumerate `tailscale status --json`, probe each candidate's
 * /.well-known/reading-room.json to confirm it runs Reading Room, and return
 * the live peers for the masthead switcher. build.ts MUST NOT import this
 * module (serve-only, like admin.ts; build-purity is pinned in admin_test.ts).
 *
 * The tailscale call and the HTTP probe are injected so the suite runs without
 * a real tailnet or network.
 */
import type { Site } from "./config.ts";
import type { Topic } from "./render.ts";

export interface PeerIdentity {
  title: string;
  version: string;
  topics: number;
  docs: number;
}

/** A live peer: only instances that answered the identity probe are returned. */
export interface Peer {
  name: string;
  url: string;
  identity: PeerIdentity;
}

/** A discovery candidate from the tailnet, pre-probe. */
export interface TailscalePeer {
  name: string;
  dnsName: string;
  online: boolean;
}

export interface DiscoverOptions {
  listPeers: () => Promise<TailscalePeer[]>;
  probe: (url: string) => Promise<PeerIdentity | null>;
  seeds?: string[];
}

export type RunFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** The identity this instance advertises at /.well-known/reading-room.json. */
export function buildIdentity(site: Site, corpus: Topic[], version: string): PeerIdentity {
  return {
    title: site.title,
    version,
    topics: corpus.length,
    docs: corpus.reduce((n, t) => n + t.docs.length, 0),
  };
}

/** Narrow an unknown probe response to a PeerIdentity, or null. */
function asIdentity(raw: unknown): PeerIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.title !== "string" || typeof o.version !== "string" ||
    typeof o.topics !== "number" || typeof o.docs !== "number"
  ) return null;
  return { title: o.title, version: o.version, topics: o.topics, docs: o.docs };
}

/** Parse `tailscale status --json` into candidate hosts. Self is reported
 * separately from Peer, so it is naturally excluded. Tolerant of junk. */
export function parseTailscalePeers(raw: unknown): TailscalePeer[] {
  if (typeof raw !== "object" || raw === null) return [];
  const peerMap = (raw as Record<string, unknown>).Peer;
  if (typeof peerMap !== "object" || peerMap === null) return [];
  const out: TailscalePeer[] = [];
  for (const v of Object.values(peerMap as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const p = v as Record<string, unknown>;
    const dnsName = typeof p.DNSName === "string" ? p.DNSName.replace(/\.$/, "") : "";
    if (!dnsName) continue;
    out.push({
      name: typeof p.HostName === "string" ? p.HostName : dnsName,
      dnsName,
      online: p.Online === true,
    });
  }
  return out;
}

const TAILSCALE_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

const defaultRun: RunFn = async (cmd, args) => {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
};

/** Resolve + run `tailscale status --json` and parse it. [] on any failure. */
export async function listTailscalePeers(run: RunFn = defaultRun): Promise<TailscalePeer[]> {
  for (const bin of TAILSCALE_BINS) {
    try {
      const { code, stdout } = await run(bin, ["status", "--json"]);
      if (code !== 0) continue;
      return parseTailscalePeers(JSON.parse(stdout));
    } catch {
      // try the next candidate binary path
    }
  }
  return [];
}

/** Fetch <baseUrl>/.well-known/reading-room.json with a timeout; null on any
 * failure or invalid shape. */
export async function probePeer(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<PeerIdentity | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL(".well-known/reading-room.json", baseUrl).href;
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return asIdentity(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Union tailnet candidates (online only) with seeds, dedupe by URL, probe in
 * parallel, keep the ones that answer with a valid identity. */
export async function discoverPeers(opts: DiscoverOptions): Promise<Peer[]> {
  const candidates = new Map<string, string>(); // url -> name
  for (const c of await opts.listPeers()) {
    if (c.online) candidates.set(`https://${c.dnsName}/`, c.name);
  }
  for (const url of opts.seeds ?? []) {
    if (candidates.has(url)) continue;
    try {
      candidates.set(url, new URL(url).hostname);
    } catch {
      // skip a malformed seed
    }
  }
  const probed = await Promise.all(
    [...candidates].map(async ([url, name]): Promise<Peer | null> => {
      const identity = await opts.probe(url);
      return identity ? { name, url, identity } : null;
    }),
  );
  return probed.filter((p): p is Peer => p !== null);
}

/** Wrap discoverPeers with a TTL cache so /api/peers doesn't spawn tailscale
 * on every request; a single in-flight call is shared. */
export function makeCachedDiscover(
  opts: DiscoverOptions,
  ttlMs = 30_000,
): () => Promise<Peer[]> {
  let cache: { at: number; peers: Peer[] } | null = null;
  let inflight: Promise<Peer[]> | null = null;
  return () => {
    const now = Date.now();
    if (cache && now - cache.at < ttlMs) return Promise.resolve(cache.peers);
    if (inflight) return inflight;
    inflight = discoverPeers(opts)
      .then((peers) => {
        cache = { at: Date.now(), peers };
        inflight = null;
        return peers;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
    return inflight;
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `deno test --allow-read --allow-write --allow-env src/discovery_test.ts` Expected: PASS (all).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/discovery.ts src/discovery_test.ts && deno lint src/discovery.ts src/discovery_test.ts
git add src/discovery.ts src/discovery_test.ts
git commit -m "feat(discovery): tailnet enumeration + identity probe + cache"
```

---

## Task 3: serve routes — identity + `/api/peers`

**Files:** Modify `src/serve.ts`; Test `src/serve_test.ts`.

- [ ] **Step 1: Failing tests** — append to `src/serve_test.ts`:

```ts
import { makeContext } from "./config.ts";
import { join } from "jsr:@std/path@1";

async function tmpCtx() {
  const home = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(home, "registry.jsonc"),
    '[\n  { "num": "§ 01", "id": "t", "name": "T", "short": "T", "docs": [ ' +
      '{ "slug": "a", "title": "A", "kind": "k", "desc": "d", "footLeft": "l", "footRight": "r", "src": "a.html" } ] }\n]\n',
  );
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
    assertEquals(typeof body.title, "string");
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
      identity: { title: "Studio", version: "0.2.0", topics: 2, docs: 5 },
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
```

(Merge `assertEquals`, `makeHandler` into existing imports if already present — do not duplicate.)

- [ ] **Step 2: Run — expect FAIL**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/serve_test.ts` Expected: FAIL
— routes/`discover` not present.

- [ ] **Step 3: Implement.** In `src/serve.ts`:

(a) Add imports near the other imports:

```ts
import { buildIdentity, listTailscalePeers, makeCachedDiscover, probePeer } from "./discovery.ts";
import type { Peer } from "./discovery.ts";
import { VERSION } from "./version.ts";
```

(b) Add `discover` to `ServeOptions`:

```ts
export interface ServeOptions {
  ctx: RoomContext;
  readonly: boolean;
  discover?: () => Promise<Peer[]>;
}
```

(c) In `makeHandler`, add the identity route. Place it right after the `adminAsset` block and before
`if (path === "/index.html")`:

```ts
if (path === "/.well-known/reading-room.json") {
  if (req.method !== "GET") return jsonError("method not allowed", 405);
  try {
    const corpus = await loadCorpus(opts.ctx.registryPath);
    return json(buildIdentity(opts.ctx.site, corpus, VERSION));
  } catch (err) {
    return jsonError(String(err), 500);
  }
}
```

(d) In `api()`, add the peers route as the first thing inside the `try` block (it is GET-only and
read-only, so it sits fine after the existing readonly gate):

```ts
  try {
    if (path === "/api/peers") {
      if (req.method !== "GET") return jsonError("method not allowed", 405);
      return json({ peers: opts.discover ? await opts.discover() : [] });
    }

    const doc = path.match(API_DOC_RE);
```

(e) In `serveMain`, wire the real cached discovery (after `const ctx = ...`, before `makeHandler`):

```ts
const ctx = await makeContext(resolveHome(a.root));
const discover = makeCachedDiscover({
  listPeers: () => listTailscalePeers(),
  probe: (url) => probePeer(url),
  seeds: ctx.site.seeds,
});
const handler = makeHandler({ ctx, readonly, discover });
```

- [ ] **Step 4: Run — expect PASS**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/serve_test.ts` Expected: PASS
(new + all existing serve tests).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/serve.ts src/serve_test.ts && deno lint src/serve.ts src/serve_test.ts
git add src/serve.ts src/serve_test.ts
git commit -m "feat(serve): /.well-known/reading-room.json identity + /api/peers"
```

---

## Task 4: build-purity guard rejects discovery.ts

**Files:** Modify `src/admin_test.ts`.

- [ ] **Step 1: Extend the existing closure test.** In `src/admin_test.ts`, in the test
      `"the static build path's import closure never touches admin.ts or comments.ts"`, add an
      assertion alongside the existing two:

```ts
assert(!seen.has("admin.ts"), "build path must not import admin.ts");
assert(!seen.has("comments.ts"), "build path must not import comments.ts");
assert(!seen.has("discovery.ts"), "build path must not import discovery.ts");
assert(seen.has("render.ts")); // sanity: the walker actually walked
```

- [ ] **Step 2: Run — expect PASS** (build.ts does not import discovery.ts, so the new assertion
      holds):

Run: `deno test --allow-read --allow-write --allow-env src/admin_test.ts` Expected: PASS.

- [ ] **Step 3: fmt + lint + commit**

```bash
deno fmt src/admin_test.ts && deno lint src/admin_test.ts
git add src/admin_test.ts
git commit -m "test(build): pin that build closure never imports discovery.ts"
```

---

## Task 5: masthead switcher (admin assets)

**Files:** Modify `assets/admin/admin.js`, `assets/admin/admin.css`; regenerate `src/assets_gen.ts`
via `deno task gen`.

No new unit test (browser UI glue, consistent with the rest of `admin.js`); the data path is covered
by Tasks 2–3, and `assets_gen_test.ts` pins generated ↔ source.

- [ ] **Step 1: Add the switcher to `assets/admin/admin.js`.** Near the top dispatch (after the
      existing `if (ctx && ctx.page === ...)` lines), add an unconditional call:

```js
const ctx = window.__RR;
if (ctx && ctx.page === "index") initIndex(ctx);
else if (ctx && ctx.page === "doc") initDoc(ctx);
initSwitcher();
```

Then add the function (place it among the shared helpers, after `run`):

```js
async function initSwitcher() {
  let peers;
  try {
    peers = (await api("GET", "/api/peers")).peers;
  } catch (_) {
    return; // discovery unavailable → no switcher
  }
  if (!peers || !peers.length) return; // no peers → no clutter
  const wrap = el("div", "rr-switcher");
  wrap.appendChild(el("span", "rr-switcher-label", "Libraries"));
  const select = el("select", "rr-switcher-select");
  const here = el("option", null, "This library");
  here.value = "";
  select.appendChild(here);
  for (const p of peers) {
    const opt = el("option", null, (p.identity && p.identity.title) || p.name || p.url);
    opt.value = p.url;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    if (select.value) location.href = select.value;
  });
  wrap.appendChild(select);
  document.body.appendChild(wrap);
}
```

- [ ] **Step 2: Add styles to `assets/admin/admin.css`** (append; match the file's ecru/mono
      editorial palette):

```css
/* peer switcher — cross-instance navigation (serve-only) */
.rr-switcher {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 9000;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font: 12px/1 ui-monospace, "JetBrains Mono", monospace;
  color: #3a2f25;
  background: rgba(244, 240, 230, 0.92);
  border: 1px solid rgba(60, 50, 40, 0.18);
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(4px);
}
.rr-switcher-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #7a6a55;
}
.rr-switcher-select {
  font: inherit;
  color: inherit;
  border: none;
  background: transparent;
  cursor: pointer;
}
```

- [ ] **Step 3: Regenerate the embedded assets**

Run: `deno task gen` Expected: rewrites `src/assets_gen.ts` (now containing the new
admin.js/admin.css). Confirm only `src/assets_gen.ts` changed (not `src/version.ts`):
`git status --short`.

- [ ] **Step 4: Verify the pin + full suite**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/assets_gen_test.ts` Expected:
PASS (generated matches source).

- [ ] **Step 5: fmt + lint + commit** (note: `assets/` and `src/assets_gen.ts` are in `fmt.exclude`;
      fmt won't touch them):

```bash
deno fmt assets/admin/admin.css >/dev/null 2>&1 || true
git add assets/admin/admin.js assets/admin/admin.css src/assets_gen.ts
git commit -m "feat(admin): masthead library switcher fed by /api/peers"
```

---

## Task 6: serve task gains `--allow-run`

**Files:** Modify `deno.jsonc`.

- [ ] **Step 1: Add `--allow-run` to the dev `serve` task** (discovery shells `tailscale`). The
      `cli` task already has `--allow-run`; only `serve` needs it. New `serve` line:

```jsonc
"serve": "deno run --allow-read --allow-write --allow-net --allow-run --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME src/serve.ts --root .",
```

- [ ] **Step 2: Verify** the dev server still starts and serves identity (manual smoke,
      backgrounded):

```bash
deno task serve >/tmp/rr.out 2>&1 &
SRV=$!; sleep 2
curl -s http://127.0.0.1:8413/.well-known/reading-room.json; echo
curl -s http://127.0.0.1:8413/api/peers; echo
kill $SRV 2>/dev/null
```

Expected: identity JSON, and `{"peers":[...]}` (likely `[]` or your tailnet peers — either is fine;
it must not 500).

- [ ] **Step 3: fmt + commit**

```bash
deno fmt deno.jsonc
git add deno.jsonc
git commit -m "chore(serve): grant --allow-run for tailnet peer discovery"
```

---

## Task 7: docs

**Files:** Modify `README.md`, `CLAUDE.md`. Prose only; verify with `deno fmt --check`.

- [ ] **Step 1: `CLAUDE.md`** — add a short subsection (near "Annotations & management") describing
      discovery: each served instance exposes `GET /.well-known/reading-room.json` (identity:
      title/version/topics/docs); `serve` discovers peers by enumerating `tailscale status --json`
      (+ optional `site.jsonc` `seeds`) and probing that endpoint, exposing the result at
      `GET /api/peers`; the masthead switcher (in `assets/admin/`) is serve-only. Note the two
      invariants: discovery is **serve-only** (`build.ts` must not import `discovery.ts`; pinned in
      `admin_test.ts`) and the serve path now needs **`--allow-run`** (already in the installed-CLI
      union). Mention mDNS is a deferred Phase 2 source.

- [ ] **Step 2: `README.md`** — add a brief "Discover other instances" note: each instance
      advertises at `/.well-known/reading-room.json`; the masthead library switcher lists peers
      found on your tailnet (and any `seeds` in `site.jsonc`); requires the instances to be exposed
      via `tailscale serve`.

- [ ] **Step 3: Verify + commit**

```bash
deno fmt CLAUDE.md README.md && deno fmt --check CLAUDE.md README.md
git add CLAUDE.md README.md
git commit -m "docs: peer discovery + library switcher"
```

---

## Task 8: full verification

- [ ] **Step 1: Full gate**

```bash
deno fmt --check
deno lint
deno test --allow-read --allow-write --allow-env --allow-run
deno publish --dry-run --allow-dirty
```

Expected: all pass; the dry-run bundle includes `src/discovery.ts` and still ships **0** `_test.ts`
files.

- [ ] **Step 2: End-to-end identity round-trip** against a throwaway home:

```bash
TMP=$(mktemp -d)
deno run -A src/cli.ts init --root "$TMP"
deno run -A --allow-run src/serve.ts --root "$TMP" >/tmp/rr2.out 2>&1 &
SRV=$!; sleep 2
echo "identity:"; curl -s http://127.0.0.1:8413/.well-known/reading-room.json; echo
echo "peers:";    curl -s http://127.0.0.1:8413/api/peers; echo
kill $SRV 2>/dev/null; rm -rf "$TMP"
```

Expected: identity JSON with `topics`/`docs`/`version`/`title`; `/api/peers` returns a JSON object
with a `peers` array (no 500).

- [ ] **Step 3: Report** pass/fail of each gate command.

---

## Self-review notes (author)

- **Spec coverage:** identity endpoint (T3), tailnet enumeration + probe + cache (T2), `/api/peers`
  (T3), switcher (T5), `seeds` (T1), permissions (T6), build-purity (T4), docs (T7), full gate (T8).
  Testability via DI (T2/T3) means no real tailnet needed.
- **Out of scope (per spec):** mDNS, central registry, replicated list, inter-instance writes.
- **Type consistency:** `PeerIdentity`/`Peer`/`TailscalePeer`/`DiscoverOptions`/`RunFn` are exported
  and used identically across `discovery.ts`, its tests, and `serve.ts`
  (`discover?: () => Promise<Peer[]>`). `buildIdentity(site, corpus, version)` signature matches
  both caller (serve) and test.
