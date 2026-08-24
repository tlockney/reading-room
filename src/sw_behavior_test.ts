import { assert, assertEquals } from "jsr:@std/assert@1";
import { renderServiceWorker } from "./pwa.ts";
import type { Topic } from "./render.ts";

/**
 * Behavioural tests for the GENERATED service worker. The worker source is a
 * plain script string, so we eval it inside a minimal mock of the SW runtime
 * (captured event listeners, in-memory CacheStorage, fake fetch) and drive its
 * install / activate / fetch paths exactly as a browser would. This is the
 * contract the offline feature rests on: everything precaches, network-first
 * when reachable, cache fallback when not, and nothing else is intercepted.
 */

const CORPUS: Topic[] = [{
  num: "§ 01",
  id: "a",
  name: "A",
  short: "A",
  docs: [
    {
      slug: "one",
      title: "One",
      kind: "k",
      desc: "d",
      footLeft: "l",
      footRight: "r",
      src: "one.html",
    },
    {
      slug: "two",
      title: "Two",
      kind: "k",
      desc: "d",
      footLeft: "l",
      footRight: "r",
      src: "two.html",
    },
  ],
}];

const ORIGIN = "http://rr.test";
// CacheStorage accepts both Requests and bare path strings (resolved against
// the worker's origin); normalize everything to a pathname.
const pathOf = (u: string | Request): string => {
  if (typeof u !== "string") u = u.url;
  return u.startsWith("/") ? u : new URL(u).pathname;
};

type SwHarness = {
  dispatch(
    type: string,
    init?: { request?: Request },
  ): { waited: Promise<unknown>[]; responses: Promise<Response>[] };
  cacheNames(): Promise<string[]>;
  cacheKeys(name: string): Promise<string[]>;
  fetchLog: string[];
  setNetwork(up: boolean): void;
  store: Map<string, Map<string, Response>>;
};

function harness(up = true): SwHarness {
  const handlers = new Map<string, (e: unknown) => void>();
  const store = new Map<string, Map<string, Response>>();
  const fetchLog: string[] = [];
  let online = up;
  // Not `async` (lint: require-await) — returns explicit promises like fetch does.
  const fetch_ = (req: Request): Promise<Response> => {
    const p = pathOf(req.url);
    fetchLog.push(p);
    if (!online) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve(
      new Response(`<html><body>fresh-${p}</body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  };
  const caches = {
    open: (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const map = store.get(name)!;
      return Promise.resolve({
        addAll: async (urls: string[]) => {
          for (const u of urls) {
            const abs = new URL(u, ORIGIN).toString(); // real SWs resolve relative entries against their origin
            map.set(pathOf(abs), await fetch_(new Request(abs)));
          }
        },
        put: (req: Request, res: Response) => {
          map.set(pathOf(req.url), res.clone());
          return Promise.resolve();
        },
        match: (req: Request | string) => Promise.resolve(map.get(pathOf(req))),
        keys: () => Promise.resolve([...map.keys()]),
      });
    },
    keys: () => Promise.resolve([...store.keys()]),
    delete: (name: string) => Promise.resolve(store.delete(name)),
    match: (req: Request | string) => {
      for (const map of store.values()) {
        const hit = map.get(pathOf(req));
        if (hit) return Promise.resolve(hit);
      }
      return Promise.resolve(undefined);
    },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, h: (e: unknown) => void) => handlers.set(t, h),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  // eslint-disable-next-line no-eval
  new Function(
    "self",
    "caches",
    "fetch",
    "addEventListener",
    "Request",
    "Response",
    "URL",
    renderServiceWorker(CORPUS),
  )(self, caches, fetch_, () => {}, Request, Response, URL);

  const dispatch = (type: string, init: { request?: Request } = {}) => {
    const waited: Promise<unknown>[] = [];
    const responses: Promise<Response>[] = [];
    const evt = {
      ...init,
      waitUntil: (p: Promise<unknown>) => waited.push(p),
      respondWith: (p: Promise<Response>) => responses.push(p),
    };
    handlers.get(type)?.(evt);
    return { waited, responses };
  };
  return {
    dispatch,
    cacheNames: () => caches.keys(),
    cacheKeys: (n) => caches.open(n).then((c) => c.keys()),
    fetchLog,
    setNetwork: (u) => {
      online = u;
    },
    store,
  };
}

const install = async (h: SwHarness) => await Promise.all(h.dispatch("install").waited);

Deno.test("install precaches the shell and every local doc", async () => {
  const h = harness();
  await install(h);
  const names = await h.cacheNames();
  assertEquals(names.length, 1);
  const keys = await h.cacheKeys(names[0]);
  for (
    const k of [
      "/",
      "/favicon.svg",
      "/icon-192.png",
      "/icon-512.png",
      "/manifest.webmanifest",
      "/docs/one",
      "/docs/two",
    ]
  ) {
    assert(keys.includes(k), `missing ${k}`);
  }
});

Deno.test("network-first: a reachable doc is served fresh and the copy is cached", async () => {
  const h = harness();
  await install(h);
  const req = new Request(`${ORIGIN}/docs/one`);
  const { responses } = h.dispatch("fetch", { request: req });
  const res = await responses[0];
  assert(res.ok);
  assert((await res.clone().text()).includes("fresh-/docs/one"));
  assert(h.fetchLog.includes("/docs/one"), "network-first must hit the network when online");
  // after the runtime fetch, the copy is cached for offline
  h.setNetwork(false);
  const cached = await h.cacheKeys((await h.cacheNames())[0]);
  assert(cached.includes("/docs/one"));
});

Deno.test("offline: a doc already in cache is served from cache", async () => {
  const h = harness();
  await install(h);
  h.setNetwork(false);
  const req = new Request(`${ORIGIN}/docs/one`);
  const { responses } = h.dispatch("fetch", { request: req });
  const res = await responses[0];
  assert(res.ok);
  assert((await res.clone().text()).includes("fresh-/docs/one"));
});

Deno.test("offline navigation to an uncached doc falls back to the cached index", async () => {
  const h = harness();
  await install(h);
  h.setNetwork(false);
  const req = new Request(`${ORIGIN}/docs/new`);
  Object.defineProperty(req, "mode", { value: "navigate" }); // Deno won't construct navigate-mode
  const { responses } = h.dispatch("fetch", { request: req });
  const res = await responses[0];
  const text = await res.clone().text();
  assert(text.includes("fresh-/"), "fallback must be the cached index");
});

Deno.test("static assets are cache-first: no network hit once precached", async () => {
  const h = harness();
  await install(h);
  const req = new Request(`${ORIGIN}/icon-192.png`);
  h.dispatch("fetch", { request: req }); // first: network (not cached yet at fetch time? it IS precached)
  // The icon is already in the precache, so the very first fetch is cache-first.
  const before = h.fetchLog.length;
  h.dispatch("fetch", { request: req });
  assertEquals(
    h.fetchLog.length,
    before,
    "cache-first must not hit the network for a precached asset",
  );
});

Deno.test("non-GET and cross-origin requests pass through untouched", async () => {
  const h = harness();
  await install(h);
  const post = new Request(`${ORIGIN}/api/docs/one/comments`, { method: "POST" });
  assertEquals(
    h.dispatch("fetch", { request: post }).responses.length,
    0,
    "POST must not be intercepted",
  );
  const cross = new Request("https://other.example/x");
  assertEquals(
    h.dispatch("fetch", { request: cross }).responses.length,
    0,
    "cross-origin must not be intercepted",
  );
});

Deno.test("activate removes caches from earlier builds", async () => {
  const h = harness();
  await install(h);
  const stale = "reading-room-0.0.0-deadbeef";
  h.store.set(stale, new Map([["/", new Response("<html></html>")]]));
  assertEquals((await h.cacheNames()).includes(stale), true);
  await Promise.all(h.dispatch("activate").waited);
  const after = await h.cacheNames();
  assert(!after.includes(stale), "stale cache must be deleted");
  assert(after.length === 1 && after[0].startsWith("reading-room-"), "current cache kept");
});
