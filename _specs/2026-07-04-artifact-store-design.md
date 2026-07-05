# Reading Room — artifact store (persistent, raw-served, tailnet-native) — design

- Date: 2026-07-04
- Status: **approved** (design conversation complete; execute in this repo)
- Builds on peer discovery (`2026-06-14`) and the content-home + CLI work (`2026-06-13`)

> In `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Turn the always-on Reading Room agent into a personal, tailnet-native **artifact host**: a place to
publish an arbitrary web document or directory — a mockup, a dashboard, a one-off report, a build
output — and get back a durable tailnet URL you can return to, list in a gallery, update, and
delete. A general-purpose, more-varied-contexts equivalent of claude.ai artifacts, reachable from
any device on the tailnet.

The enabling insight the user identified: **only the open-source Tailscale client on macOS can
`tailscale serve` a filesystem path**; the App Store / standalone client can only proxy to a
localhost port. But the Reading Room agent is *already* that localhost port, already fronted by
`tailscale serve <port>`. So if the agent can serve arbitrary snapshotted content, arbitrary files
become reachable over the tailnet through the port-proxy the App Store client *can* do — with no
open-source client and no second static server per share.

## Decisions (from the design conversation)

1. **A separate, raw-served store — a sibling to the curated library, not part of it.** The library
   already persists standalone HTML at stable `/docs/<slug>` tailnet URLs with a management API, so
   the real distinguishing line is **rendering + curation**: library docs are *curated and
   transformed* (editorial authoring, a topic, title/kind/desc, and the server heals them + injects
   the editorial/admin/comments chrome); artifacts are *persisted and served verbatim* — any web
   document, no chrome, no topic, low ceremony. That raw-serving requirement is precisely why
   artifacts cannot just be registry docs served through `/docs/` (that path transforms everything).
   The two subsystems **share the serving substrate** (running server, `tailscale serve` proxy,
   localhost management-API pattern, the tailnet-URL builder) but nothing of the editorial render
   path.

2. **Content is snapshotted (copy-in), not referenced.** On publish, content is copied into the
   content home and served from there — immutable until an explicit `update`. Durable (the source
   can move, change, or be deleted), a self-contained payload (which sets up taildrop transfer
   cleanly — see the tie-in below), and consistent with the `_migrated/` precedent and the
   "redeploy to update" model. A live-reference mode was **rejected** for v1 (fragile, not a real
   snapshot, awkward to taildrop).

3. **Ephemeral-vs-persistent: persistent.** An earlier iteration scoped this as ephemeral in-memory
   shares; the design was deliberately reopened and moved to a durable store precisely to make it an
   artifact host rather than a "glance at this once" affordance.

4. **The store is serve-only, like `admin.ts` / `comments.ts` / `discovery.ts`.** It never appears
   in static builds (`build.ts` must not import it), and its management routes are disabled under
   `READONLY=1`.

5. **Readable, stable slugs.** The URL slug is derived from the document `<title>` (or the basename),
   overridable with `--name`, and auto-deduped on collision (`mockup` → `mockup-2`). The slug is
   **immutable** once created, so published URLs never break; only the display `title` is editable.

6. **The tailnet is the trust boundary — no Funnel.** Reachability is tailnet-only, exactly like the
   rest of the Reading Room. Public exposure stays the job of the existing `tailscale-share
   --funnel` skill, not this feature.

7. **A browsable gallery.** The store gets a serve-only gallery page (like the artifacts gallery),
   distinct from the editorial library index.

## Why not the obvious alternatives

- **Uncurated docs inside the existing library** (a doc with no topic, hidden from the index) —
  reuses `registry.jsonc` + `/docs/` + the management API, but inherits the editorial/admin
  transform, so content is **not** served raw. That limits it to RR-style HTML and defeats the
  "arbitrary web document" goal. Rejected.
- **A separate companion server** (a second process on a second port, its own `tailscale serve`
  binding) — this is what the existing `ts-share` / `tailscale-share` skill already does for hosts
  where no RR agent runs. The whole point here is to **not** spin that up when the agent is already
  live. Rejected as the model, retained as the complementary tool (see "Relationship to
  `tailscale-share`").
- **Live-reference (serve from the original path)** — fragile and not a snapshot; see decision 2.
- **Funnel / public exposure** — out of scope; see decision 6.

## Architecture — four decoupled parts

```
(1) Store            content home: artifacts/<slug>/… (copy-in) + artifacts.json (manifest)
(2) Content route    GET /artifacts/<slug>/<rest?>  → serve snapshot RAW (containment-checked)
(3) Management API   POST/GET/PUT/PATCH/DELETE /api/artifacts…  (localhost, serve-only, READONLY-gated)
(4) Gallery + CLI    GET /artifacts (serve-only UI) · `reading-room artifact …` drives (3)
```

Decoupling keeps the raw content path independent of the management surface and the gallery UI, and
keeps all of it out of the build path.

## Naming

User-facing noun/verb: **`artifact`**. CLI verb `reading-room artifact`, route namespace
`/artifacts`, manifest `artifacts.json`, content dir `artifacts/`. Chosen over `share` (overloaded:
`tailscale serve`, the `tailscale-share` skill; names the act, not the thing) and `stash` (its
git-stash "temporary, pop-and-discard" connotation fights the durable-snapshot semantics).
`artifact` is evergreen and self-describing and matches the "alternative to Claude artifacts"
framing.

## Storage (content home — respects the engine / content-home split)

Artifacts are **content**, so they live in the content home alongside `_migrated/` and `comments/`;
engine code stays generic.

- `artifacts/<slug>/…` — the copied-in snapshot. A single-file publish copies the one file in; a
  directory publish copies the whole tree.
- `artifacts.json` — a **machine-managed** manifest (plain JSON, written with the existing
  `writeAtomic` from `comments.ts`). No JSONC comment-preservation string-surgery is needed here —
  unlike `registry.jsonc`, this file is never hand-curated, matching the `comments/<slug>.json`
  sidecar precedent. Shape:

  ```jsonc
  {
    "artifacts": [
      {
        "slug": "mockup",
        "title": "Landing Page Mockup",   // from <title>, else basename; editable
        "entry": "index.html",             // file served at the slug root
        "isDir": true,
        "createdAt": "2026-07-04T…Z",
        "updatedAt": "2026-07-04T…Z",
        "bytes": 48213                      // total snapshot size, for the gallery
      }
    ]
  }
  ```

- `RoomContext` (`src/config.ts`) gains `artifactsDir` and `artifactsManifest`, threaded like the
  existing `commentsDir`. Both are created lazily on first publish (no scaffolding required in
  `init`).

## Component design

### `entry` resolution (publish time)

- **Single file:** `entry` = the file's basename; `isDir = false`. It is copied to
  `artifacts/<slug>/<basename>`.
- **Directory:** the tree is copied to `artifacts/<slug>/`. `entry` = `index.html` if present at the
  root, else `null` (a directory listing is served at the slug root). `isDir = true`.
- `title`: for an HTML entry, the first `<title>…</title>` text; otherwise the basename. `--title`
  overrides.

### Content route — `GET /artifacts/<slug>/<rest?>`

- Resolve `<slug>` in the manifest → 404 if unknown.
- Serve **raw**, with **no editorial/admin transform**, via `@std/http/file-server`
  (`serveDir` for `isDir` with `showIndex` + `showDirListing`; `serveFile` for single-file, mapping
  the slug root to `entry`).
- **Path containment is enforced** — resolve the requested path against `artifacts/<slug>/` and
  reject anything that escapes it (the one security-sensitive path). `serveDir`'s own root-jail is
  the mechanism; a test pins a `../` rejection.
- `GET /artifacts/<slug>` (no trailing slash) → **301** to `/artifacts/<slug>/`, so relative asset
  links inside the artifact resolve against the slug root.

### Gallery — `GET /artifacts` (exact) / `GET /artifacts/`

- Routing: the bare `/artifacts` (and `/artifacts/`) is the gallery; `/artifacts/<slug>/…` is
  content. A slug can therefore never be empty, so the two never collide.
- A **serve-only** page listing manifest entries as cards: `title`, `updatedAt`, `bytes`, a link to
  `/artifacts/<slug>/`. Deliberately **not** the editorial bundle — a light standalone layout, kept
  visually distinct from the library index.
- Optional small masthead link from the library index (off by default; a later polish, not
  load-bearing).
- Empty-state copy when there are no artifacts.

### Management API (localhost, serve-only, `403` under `READONLY=1`)

Mounted under `/api/artifacts`, mirroring the existing `/api/docs` dispatch and its `READONLY`
guard.

| Method + path | Body | Effect |
|---|---|---|
| `POST /api/artifacts` | `{ path, name?, title? }` | validate + copy-in, write manifest, `201 { slug, url, localUrl }` |
| `GET /api/artifacts` | — | list all entries |
| `GET /api/artifacts/<slug>` | — | one entry |
| `PUT /api/artifacts/<slug>` | `{ path }` | re-snapshot content, bump `updatedAt` (redeploy-to-same-URL) |
| `PATCH /api/artifacts/<slug>` | `{ title }` | edit display title (slug immutable) |
| `DELETE /api/artifacts/<slug>` | — | drop manifest entry + delete `artifacts/<slug>/` |

`POST`/`PUT` read an arbitrary source path server-side (already within serve's unrestricted
`--allow-read`) and write only into the content home. Validation: the source path must exist and be
readable — a missing or unreadable path returns a clear `400`. No path-jail on the *source* is
needed (read is already unrestricted); the jail that matters is on *serving* (containment, above).

### CLI (`src/cli.ts` → new `src/artifact.ts` command module)

- `reading-room artifact <path> [--name X] [--title T] [--port N]` — `POST`; print the tailnet URL
  (and the localhost fallback).
- `reading-room artifact list` — `GET`; pretty-print slug · title · updated · url.
- `reading-room artifact update <slug> <path>` — `PUT`.
- `reading-room artifact rm <slug>` — `DELETE`.

Port resolves `--port` → `$PORT` → `8413` (the agent default). If no server answers on that port,
fail with a clear message ("no running Reading Room agent on :<port> — is it installed? see
`agent.sh install`"). The CLI talks only to `127.0.0.1` — it never needs the tailnet itself.

### Tailnet URL construction

Reuse discovery's `tailscale status --json` shell-out to read **this** node's `DNSName`, yielding
`https://<host>.<tailnet>.ts.net/artifacts/<slug>/`. **Dependency-injected** exactly like
`discovery.ts`, so the suite needs no real tailnet. If `tailscale serve` is not fronting the port,
print the localhost URL plus a hint that the tailnet URL needs `tailscale serve --bg <port>` (which
`agent.sh install` already runs).

## Invariants to preserve

1. **Serve-only.** `build.ts` must never import the artifact-store module. Add it to the
   `admin_test.ts` import-purity pin alongside `admin.ts` / `comments.ts` / `discovery.ts`.
2. **Content-home storage, generic engine.** Artifacts and their manifest live in the content home;
   engine code hardcodes no machine identity or path. The split holds.
3. **Raw serving.** No `transformDoc`, no `injectAdmin`, no editorial bundle on `/artifacts/<slug>/`
   content. The gallery is UI and may be styled, but artifact *content* is byte-for-byte what was
   snapshotted.
4. **`READONLY=1` gates all mutation** (`POST`/`PUT`/`PATCH`/`DELETE`), consistent with `/api/docs`.
5. **No new permissions.** serve already carries unrestricted `--allow-read` / `--allow-write` and
   `--allow-run` (for the tailscale shell-out). Nothing to add to the launchd agent or the installed
   CLI permission union.

## Security

- **Trust boundary = the tailnet**, unchanged. Readable slugs are acceptable within it (the user's
  explicit call); the URL is not a capability.
- **Containment check** on every content request is the one real hazard and is tested.
- Copy-in reads arbitrary source paths (already permitted) and writes only inside the content home.

## Testing (TDD)

- **Content route (handler):** serve a single-file artifact; serve a directory artifact (index +
  listing); `/artifacts/<slug>` → `/artifacts/<slug>/` redirect; 404 unknown slug; **containment
  rejection** (`../` escape); `READONLY` 403 on each mutation verb.
- **Store / manifest (unit):** slug derivation + dedupe; `<title>` extraction (and basename
  fallback); copy-in of a file and of a directory tree; `update` re-snapshots and bumps
  `updatedAt`; `delete` removes both the manifest entry and `artifacts/<slug>/`.
- **Gallery:** renders one card per entry; empty state.
- **CLI:** arg parsing for each subcommand; the "no server running" error path.
- The tailscale hostname lookup is injected/faked, like the discovery suite.

## Relationship to `tailscale-share`

Intentional overlap, different niche. `tailscale-share` (`ts-share`) spins up its **own** static
server + its **own** `tailscale serve` binding on a fresh port — the right tool on a host where no
Reading Room agent runs, or for a genuinely throwaway one-off, or for `--funnel` public sharing.
This feature is the "the agent is already up, piggyback on it, and keep the thing durably" path. The
spec notes the relationship; it does **not** modify that skill.

## Rollout

The change lands in the engine (`reading-room-lib` / JSR `@tlockney/reading-room`). Shipping it is a
version bump + a per-machine `deno install -g -f …` at the new version (and the launchd agent picks
it up on next start). This is called out here and belongs in the implementation plan's final step —
not done silently as part of the code work.

## Tie-in to enhancement #2 (taildrop)

A snapshotted artifact directory is a self-contained payload — exactly what enhancement #2 (transfer
Reading Room files between machines via `tailscale file cp`) would move. Designing copy-in now means
that feature can taildrop an artifact (or a library doc) without a separate packaging step. That
enhancement remains a **separate** spec/plan cycle; this note only records that the two are no longer
fully independent, and that copy-in was chosen partly with it in mind.
