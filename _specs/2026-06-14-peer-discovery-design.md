# Reading Room — peer discovery & cross-instance navigation — design

- Date: 2026-06-14
- Status: **approved** (design conversation complete; execute in this repo)
- Builds on the content-home + CLI work (`2026-06-14`/`2026-06-13` specs)

> In `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Let each Reading Room instance advertise itself and discover the others, so a user can navigate
between instances from the masthead. Crucially, **without a peer list that must be hand-copied to
every machine** — the failure mode that kills replicated-config schemes (add a host → re-copy the
list everywhere → drift).

## Decisions (from the design conversation)

1. **The tailnet is the membership source of truth.** Every instance is exposed over Tailscale
   (`tailscale serve`), and Tailscale already maintains + replicates the device list to every node.
   So discovery **enumerates the tailnet** rather than maintaining a list. Adding a host to the
   tailnet — which you must do anyway to reach it across networks — makes it discoverable on every
   instance with zero further action. This directly dissolves the "copy the list to each machine"
   concern: there is no list.
2. **Discovery is a union of pluggable sources behind one probe.** Topology is "mixed / will grow
   into both" (some LAN, some remote). Phase 1 ships the Tailscale source + an optional `seeds`
   escape hatch. **mDNS is deferred** to a later phase as a second source for LAN-only hosts not on
   the tailnet — a safe addition because every source funnels through the same identity probe.
3. **A self-description endpoint is the common primitive.** `GET /.well-known/reading-room.json`
   returns the instance's identity; every discovery source confirms a candidate by fetching it.
   Liveness is therefore always verified live — a stale name is never trusted.
4. **Discovery and the switcher are serve-only**, like `admin.ts` / `comments.ts`. They never appear
   in static builds (you cannot discover peers from an S3 file), and `build.ts` must not import the
   discovery module.

## Why not the obvious alternatives

- **Replicated static list** — N copies of one truth; drifts on every host change. Rejected (it is
  the exact pain we're solving).
- **mDNS-first** — only spans one LAN segment; Tailscale carries no multicast, and the instances
  span networks. Wrong substrate as the foundation; fine later as a LAN booster.
- **Central registry host** — reintroduces a bootstrap/SPOF. The tailnet already is the shared,
  auto-replicated registry, so no extra host is needed.

## Architecture — three decoupled parts

```
(1) Identity endpoint   GET /.well-known/reading-room.json  → { title, version, topics, docs }
(2) Discovery           tailnet peers (∪ seeds) → probe each (1) → live Peer[]
(3) Switcher UI         masthead control (serve-only) → GET /api/peers → navigate
```

Decoupling lets the discovery _source_ change (add mDNS) without touching the endpoint or the UI.

## Component design

### `/.well-known/reading-room.json` (identity)

- New top-level route in `makeHandler` (before the `/api/` dispatch). `GET` → 200 JSON; other
  methods → 405. Served **always**, including under `READONLY` (it is read-only info; peers must be
  able to probe a view-only instance). Short `cache-control`.
- Body = `buildIdentity(site, corpus)` (pure):
  `{ title: site.title, version: VERSION,
  topics: corpus.length, docs: <sum of t.docs.length> }`.
  No URLs self-reported — the prober already knows the URL it reached.
- Served at the tailnet root via `tailscale serve`, so a peer is probeable at
  `https://<host>.<tailnet>.ts.net/.well-known/reading-room.json` (the documented exposure model).

### `src/discovery.ts` (serve-only, dependency-injected for tests)

Pure / dependency-injected split so the suite never needs a real tailnet:

```ts
export interface PeerIdentity {
  title: string;
  version: string;
  topics: number;
  docs: number;
}
export interface Peer {
  name: string;
  url: string;
  identity: PeerIdentity;
} // only live peers returned

// pure: parse `tailscale status --json` → candidate hosts (self excluded)
export function parseTailscalePeers(
  raw: unknown,
): { name: string; dnsName: string; online: boolean }[];

// injected runner (default real Deno.Command); resolves the tailscale binary like agent.sh does
export function listTailscalePeers(
  run?: RunFn,
): Promise<{ name: string; dnsName: string; online: boolean }[]>;

// fetch <base>/.well-known/reading-room.json with a timeout; null on any failure/!valid
export function probePeer(
  baseUrl: string,
  fetchFn?: typeof fetch,
  timeoutMs?: number,
): Promise<PeerIdentity | null>;

// union sources → dedupe by url → probe in parallel → keep live. listPeers/probe injected for tests.
export function discoverPeers(opts: {
  listPeers: () => Promise<{ name: string; dnsName: string; online: boolean }[]>;
  probe: (url: string) => Promise<PeerIdentity | null>;
  seeds?: string[];
}): Promise<Peer[]>;
```

- Candidate URL from a tailnet peer: `https://<dnsName-without-trailing-dot>/`. Seeds are base URLs
  used as-is. Dedupe by URL. Probe only `online` peers (+ all seeds), in parallel, each with a ~1.5s
  `AbortController` timeout; a peer that doesn't answer the probe (no RR, offline, non-JSON) is
  silently dropped.
- **TTL cache** (~30s, module-level keyed by nothing — one instance) so `/api/peers` doesn't spawn
  `tailscale` on every request. `Date.now()` is fine in runtime code. Tests exercise `discoverPeers`
  directly (bypassing the cache) with fakes.

### `/api/peers` route

- Add to the `/api/` handler as a **GET-only** route → `json({ peers })`, where `peers` is the
  cached discovery result. Read-only, so unaffected by `READONLY`. For testability, `makeHandler`'s
  `ServeOptions` gains an optional `discover?: () => Promise<Peer[]>`; `serveMain` wires the real
  cached discovery (built from `ctx.site.seeds`), tests pass a fake.

### Switcher UI (admin layer, always-visible)

- The switcher is a **navigation** affordance, so it is visible on every served page (not gated
  behind manage mode), but it is still **serve-only** (injected by `admin.ts` via `assets/admin/`,
  absent from builds).
- Implementation in `assets/admin/admin.js`: a fixed-position control appended to `<body>` (same
  pattern as the manage button / toast, so it is page-structure-independent). On load it
  `fetch('/api/peers')`; if peers exist, it renders a small dropdown of `peer.identity.title` →
  `peer.url`. Empty/failed fetch → the control stays hidden (no peers, no clutter). Styles in
  `assets/admin/admin.css`. After editing `assets/`, run `deno task gen` (pins `assets_gen.ts`).

### `site.jsonc` — optional `seeds`

- Extend `Site` with `seeds?: string[]` (base URLs). `parseSite` validates it as an array of
  strings. Default: absent. This is the escape hatch for a host the auto-sources can't see; it is
  **not** the mechanism.

## Permissions

`discovery.ts` shells `tailscale status --json`, so the **serve** path needs `--allow-run` (peer
probing uses `--allow-net`, already present). The installed CLI's permission union already includes
`--allow-run`. The dev `serve`/`cli` tasks in `deno.jsonc` gain `--allow-run` (scope to the
tailscale binary is unreliable because it may resolve to an absolute app path, so unscoped
`--allow-run`, matching the installed CLI). Document the widening.

## Build purity

`discovery.ts` is serve-only. `build.ts` must never import it (same rule as
`admin.ts`/`comments.ts`). Extend the build import-closure guard (`admin_test.ts` / `build_test.ts`)
to also reject `discovery.ts` in the build closure.

## Testing (no real tailnet required)

- `parseTailscalePeers`: realistic `tailscale status --json` fixture → expected hosts; excludes
  self; tolerates missing/extra fields without throwing.
- `probePeer`: injected `fetchFn` returning a valid identity → `PeerIdentity`; returning 404 / a
  non-JSON body / throwing / timing out → `null`.
- `discoverPeers`: injected `listPeers` + `probe` (no network) → unions tailnet + seeds, dedupes by
  URL, drops non-answering candidates, returns live peers.
- `buildIdentity`: pure, from a `Site` + corpus fixture.
- Handler routes via `makeHandler` with an injected `discover` fake:
  `/.well-known/reading-room.json` GET → identity JSON, non-GET → 405; `/api/peers` GET →
  `{ peers }`; both work under `READONLY`.
- Build purity: `build.ts` import closure excludes `discovery.ts`.

## Phasing

- **Phase 1 (this spec):** identity endpoint + Tailscale enumeration + optional `seeds` + switcher.
  Solves the stated concern end-to-end.
- **Phase 2 (later, only if a non-tailnet LAN host appears):** add an mDNS source
  (`_readingroom._tcp`) feeding the same probe. Out of scope here.

## Non-goals

- No mDNS now; no central registry host; no replicated peer-list file.
- No write/coordination between instances — discovery is read-only navigation.
- No change to the content/engine split, render pipeline, or static build output.
- Instances are assumed exposed at their tailnet root via `tailscale serve`; non-standard exposures
  are covered by `seeds`, not by guessing alternate ports.
