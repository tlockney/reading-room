# Reading Room — peer-to-peer document transfer (over the server APIs) — design

- Date: 2026-07-05
- Status: **approved** (design conversation complete; execute in this repo)
- Builds on peer discovery (`2026-06-14`) and the content-home + CLI work (`2026-06-13`)

> In `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Let a user **send a curated library document to another of their Reading Room instances** — from
the web UI or the CLI — picking the destination from the same peer list the masthead library
switcher already shows. The doc arrives on the far end quarantined for review, so it never silently
appears as curated.

## The pivotal decision: HTTP over the server APIs, not Taildrop

The idea began as "transfer files with `tailscale file cp`" (Taildrop). That was reconsidered and
**rejected** as incidental complexity. Both machines already run the Reading Room server, already
exposed over the tailnet via `tailscale serve` (HTTPS, tailnet-authenticated), and discovery already
knows each peer's base URL. So a transfer is just **the local server POSTing the doc to the peer's
own API** — no `tailscale file cp`/`get` shell-out, no tar bundle, no OS Taildrop inbox, no drain
step, and no resolving peers down to tailnet node names (the discovered peer's `url` *is* the
target).

What Taildrop would have bought, and why we don't need it:

- **Offline/async delivery** to a sleeping machine — but discovery only lists **online** peers, so
  the picker never offers an offline target anyway. The loss is theoretical for this use case.
- **Sending to non-RR devices** (a phone) — but targets are scoped to discovered Reading Room
  libraries by design (the receiver must run the engine to file the doc).

So the mechanism is a synchronous HTTP push between two RR instances over the tailnet.

## Decisions (from the design conversation)

1. **Push, initiated from the source.** `POST /api/docs/<slug>/send { target }` on the sender's
   own server. Sending reads a doc and copies it out; it does not mutate the sender's library.
2. **Docs only.** Curated library docs (`_migrated/<slug>.html` + registry metadata). Artifacts
   (the 2026-07-04 store) are out of scope; that store can grow its own transfer later.
3. **JSON payload, not an archive.** The wire format is `{ html, meta, comments? }` — no `.rrbundle`
   tar. The engine already models a doc as standalone HTML + registry metadata + an optional
   comments sidecar; the payload mirrors that split as JSON fields.
4. **Comments ride along only with `--with-comments`** (default off). Annotations are personal
   review apparatus; the common "share the doc" case shouldn't drag margin notes along.
5. **Receive is passive and quarantined.** `POST /api/receive` files the incoming doc with
   `review: true` into a dedicated **"Received"** topic (created if absent), so it lands in the
   index's For-Review section. There is **no** receive command, inbox, or drain — the doc appears
   when the POST arrives. The user vets it and re-files it into a real topic.
6. **Target selection reuses discovery unchanged.** The "Send to" control is populated from
   `GET /api/peers`; the chosen peer's `url` is the POST target. No change to the `Peer` shape.
7. **Serve-only, `READONLY`-gated.** Both routes are management actions: disabled under `READONLY=1`
   (a view-only instance neither sends nor accepts pushed docs), and the transfer module never
   touches the build path.

## Why not the obvious alternatives

- **Taildrop (`tailscale file cp`/`get`)** — see "The pivotal decision" above. Rejected as
  incidental complexity for benefits this use case doesn't need.
- **Browser posts cross-origin directly to the peer** — the user's browser is on the tailnet and
  could `fetch('https://peer/api/receive', …)`, but that needs CORS on the peer and duplicates the
  logic for the CLI. **Server-side forwarding** (local server → peer) gives one code path for UI and
  CLI and no CORS. Chosen.
- **Auto-file received docs as live** — a doc from another library, dropped straight into the
  curated index, is a bigger commitment than it looks and hits the sender-topic-doesn't-exist-here
  problem. Quarantine-as-review sidesteps both. Rejected.
- **A background receive watcher** — passive HTTP receipt already means docs "just appear"; no
  daemon needed. Out of scope.

## Architecture — one core module, two routes, two clients

```
(1) Core          src/transfer.ts: buildDocPayload · parseReceivedPayload · receiveDoc · sendDoc
(2) Send route    POST /api/docs/<slug>/send { target }  → forwards POST <target>api/receive
(3) Receive route POST /api/receive { html, meta, comments? } → files review:true into "Received"
(4) Clients       Admin UI "Send to ▾" (from /api/peers) · `reading-room send` CLI (thin client)
```

The core module is pure engine logic with the outbound `fetch` injected (like `discovery.ts`'s
tailscale runner), so the whole send↔receive round-trip is testable with no network.

## Component design

### Payload types (`src/transfer.ts`)

```ts
export interface DocMeta {
  title: string;
  kind: string;
  desc: string;
  footLeft: string;
  footRight: string;
  originTopic: string; // the sender's topic id — advisory, for the user re-filing
  visibility: "private" | "shared";
  origin: string; // sender instance name (resolveInstanceName)
}
export interface DocPayload {
  html: string;
  meta: DocMeta;
  comments?: Comment[]; // from comments.ts; present only if sent --with-comments
}
```

### `buildDocPayload(ctx, corpus, slug, opts): Promise<DocPayload>`

- Resolve the doc in `corpus`; 404 if unknown.
- `html`: read the canonical source — the `_migrated/<slug>.html` override if present, else the
  doc's `src` path (same precedence `transformDoc` uses).
- `meta`: the doc's registry fields + `originTopic` (its topic id) + `origin`
  (`resolveInstanceName(ctx.site)`).
- `comments`: `loadComments(ctx.commentsDir, slug)` only when `opts.withComments`.

### `sendDoc(ctx, corpus, slug, target, opts, fetchFn): Promise<{ ok: boolean; slug?: string; error?: string }>`

- `buildDocPayload(...)`, then `POST new URL("api/receive", target)` with the JSON body (`target`
  is a peer base URL like `https://host.tailnet.ts.net/`, so relative resolution yields
  `…/api/receive`).
- `fetchFn` defaults to `fetch`, injected for tests. On success, `slug` is the slug the receiver
  assigned; a non-2xx or network failure returns `{ ok: false, error }` (surfaced as the route's
  response).

### `parseReceivedPayload(raw: unknown): DocPayload | string`

- Narrow `unknown` → validated `DocPayload` (every `meta` field type-checked; `comments` optional
  array), or a message string. Same validate-or-explain idiom as `parseCommentInput` /
  `parsePatch`.

### `receiveDoc(ctx, payload): Promise<{ slug; topic: "received" }>`

- Ensure the **"Received"** topic exists (reserved id `received`; create via `insertTopic` if
  absent).
- Derive a unique slug from `meta.title`/incoming slug, **deduped** against the registry (a
  re-received doc becomes a *new* For-Review entry — it never overwrites an existing slug).
- Write `_migrated/<slug>.html` (the payload html), and if `payload.comments`, write the
  `comments/<slug>.json` sidecar.
- Insert a registry entry via `insertDoc(registry, "received", entry)` with the payload's
  title/kind/footers/visibility, `review: true`, and provenance appended to `desc`
  (`"<desc> (received from <origin>)"`).
- Returns the filed slug.

### Serve routes (`src/serve.ts`, inside the existing `api()` — inherits the `READONLY` 403 guard)

- `POST /api/docs/<slug>/send { target: string }` → a **new route** on its own regex
  (`API_DOC_SEND_RE = /^\/api\/docs\/([A-Za-z0-9_-]+)\/send$/`, matched before the existing
  `API_DOC_RE` so the `/send` suffix isn't swallowed) → validate `target` is a string URL →
  `sendDoc(...)` → `200 { ok, slug }` (the receiver-assigned slug) or a 4xx/502 carrying the peer's
  error.
- `POST /api/receive` → `parseReceivedPayload` (400 on bad body) → `receiveDoc(...)` →
  `201 { ok, slug }`.

### Admin UI (`assets/admin/*`)

A **"Send to ▾"** control in a doc's manage-mode layer (beside the existing review/visibility/remove
controls). Its menu is filled from `GET /api/peers`; choosing a peer `POST`s
`/api/docs/<slug>/send { target: peer.url }` to the **local** server and reports success/failure.
Thin JS over the existing admin bundle; the behavior is covered by the route tests, not browser
tests.

### CLI (`src/transfer-cli.ts`, wired into `cli.ts`)

`reading-room send <slug> <peer> [--with-comments] [--port N]` — a thin client to the local server
(like `reading-room artifact`): it `GET`s `/api/peers`, resolves `<peer>` by name (or accepts a URL
directly), then `POST`s `/api/docs/<slug>/send`. Clear error if no local agent is running, if the
peer name is unknown, or if the peer is unreachable.

## Invariants to preserve

1. **Serve-only.** `build.ts`/`render.ts` must never import `transfer.ts`; add it to the
   `admin_test.ts` import-closure pin (alongside `admin.ts`/`comments.ts`/`discovery.ts`).
2. **`READONLY=1` gates both routes** (send and receive are management actions), via the top-of-
   `api()` guard.
3. **No new permissions.** serve already has `--allow-net` (the outbound POST), `--allow-read`/
   `--allow-write`. Notably, transfer shells out to **nothing** — dropping Taildrop means no new
   `--allow-run` surface beyond what discovery already uses.
4. **Content-home split.** Transfer is engine behavior; docs, the comments sidecars, and the
   "Received" topic all live in the content home.

## Security

- **Trust boundary = the tailnet**, unchanged. `tailscale serve` already exposes every `/api/*`
  route to tailnet members; `POST /api/receive` is a new inbound **write**, so state it plainly: any
  tailnet member can drop a doc into your **Received** queue. Mitigations: it lands `review: true`
  (never live), a `READONLY` instance rejects it, and the tailnet is your own devices.
- The receiver treats the payload as untrusted input: `parseReceivedPayload` validates every field;
  the html is stored and served through the **same** render path as any doc (which already strips
  stale admin/editorial regions), and slugs are engine-derived (never taken raw from the payload),
  so a hostile `slug`/path can't escape `_migrated/`.

## Testing (TDD)

- **Payload round-trip:** `buildDocPayload` assembles the right fields (with/without comments);
  `parseReceivedPayload` accepts a good body and rejects each malformed shape.
- **Receive:** `receiveDoc` creates the "Received" topic when absent, files with `review: true`,
  dedupes a colliding slug into a second entry, appends provenance to `desc`, and writes the
  comments sidecar only when comments are present.
- **Send:** `sendDoc` posts to `<target>api/receive` with the correct body (injected `fetchFn`); a
  non-2xx / network error surfaces as a clear failure.
- **Round-trip integration:** a faked `fetchFn` that routes the send straight into a *second*
  in-memory `makeHandler`'s `/api/receive`, asserting the doc lands filed on the "receiver".
- **Routes:** `POST /api/docs/<slug>/send` and `POST /api/receive` incl. `READONLY` 403, unknown
  slug 404, malformed body 400, unreachable/absent target error.
- **CLI:** peer-name resolution and request mapping (pure helpers, faked), and the no-agent error.
- **Build purity:** the `admin_test.ts` import-closure pin rejects `transfer.ts`.
- All tailscale/network calls are injected — the suite needs no tailnet.

## Non-goals

- No Taildrop, no pull/request protocol, no background receive watcher.
- No artifacts (docs only).
- No sending to non-RR tailnet nodes.
- No conflict resolution beyond quarantine-as-review (a re-received slug is a new For-Review entry,
  never an overwrite).
- No per-peer authz beyond the tailnet boundary + `READONLY`.

## Rollout

Lands in the engine (`reading-room-lib` / JSR `@tlockney/reading-room`): version bump + per-machine
`deno install -g -f` at the new version; the launchd agent picks it up on next start. Independent of
the 2026-07-04 artifact store — no dependency either way.
