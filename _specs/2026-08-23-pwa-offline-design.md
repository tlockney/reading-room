# Reading Room — PWA: installable + offline library — design

- Date: 2026-08-23
- Status: proposed (assumptions listed for review; execute on approval)
- Builds on: the engine/content-home split (`2026-06-13`), the editorial bundle + favicon head
  region (`render.ts`), and the serve/build parity contract.

> In `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Make the Reading Room a **Progressive Web App**: installable from any device that reaches it, and
**fully readable offline**. "Offline" here means the whole local corpus — every document the
instance serves — should be available with no server reachable (airplane, machine off, server
down). This is a natural fit for a personal, tailnet-exposed, local-first document library: the
library already lives on machines the user owns; the PWA turns it into an app you can open like a
book, even mid-flight.

## What a PWA needs, mapped onto this engine

1. **Web app manifest** — name, short_name, icons, start_url, display mode, colors. Derived from the
   existing `site.jsonc` identity + the fixed editorial palette, so **no new per-machine config**.
2. **Service worker** — precaches the corpus at install; serves it (or the network) on fetch. This
   is where "include all the local docs" is realized.
3. **Icon set** — Chrome's installability wants 192×192 and 512×512 PNGs. The engine already ships
   `favicon.svg` (64px) and `apple-touch-icon.png` (180px); 192/512 PNGs are added.
4. **Registration** — `<link rel="manifest">`, `<meta name="theme-color">`, and the SW registration
   script ride the existing RR-only head region that `render.ts` injects into every page (index and
   docs), and that `portableHtml` already strips from downloads. No new injection machinery.

## Key design decisions

### D1. PWA is engine behavior, not content-home config

Per the repo's engine/content-home rule ("is this engine behavior, or machine specificity?"),
offline + installability is engine behavior: every content home gets it on a CLI upgrade, no
per-machine fork. Per-machine identity (app name, lede) already lives in `site.jsonc` and flows into
the manifest via `renderManifest(site)`. **No new `site.jsonc` fields** were added — an app name,
short name, and icon set derived from existing identity + the editorial palette is good enough; a
future `site.jsonc` `pwa` block is the natural extension point if a machine wants to diverge.

### D2. "All the local docs" = everything the instance serves

The service worker's precache list is generated from the same corpus the server renders, so:

- **Live server** (`serve.ts`): precaches the **full corpus** — including `private` docs, matching
  what the tailnet-exposed instance serves (access remains gated by Tailscale ACLs).
- **Static publish** (`build.ts`): precaches the **`visibility: shared` subset** — exactly what the
  build wrote, so a published instance is installable + offline too, and never leaks private docs.

### D3. Network-first runtime, precache-at-install

The runtime fetch policy is **network-first** for pages and docs, with cache fallback:

- When the server is reachable (localhost/tailnet — i.e. almost always), the freshest content wins.
  This preserves the engine's core ethos: *edits to the registry or a doc show up on refresh*.
- When the server is unreachable, the precache (and any runtime-cached copy) serves the last good
  version. For a doc that was never seen before and isn't precached, offline navigation falls back
  to the cached index rather than a dead screen.

Alternatives considered and rejected:

- **Cache-first / stale-while-revalidate** — would mask live edits behind the cached copy until a
  second visit. Wrong for a library whose defining feature is live re-render.
- **Pure offline-first (install-only, no network after)** — wrong for a tool where the server is
  normally up and the user edits regularly.

Static assets (icons, manifest, favicon) are **cache-first** — they don't change under the same
origin, and there's no reason to hit the network for them once precached.

### D4. The service worker is generated, and changes when the library changes

`/sw.js` is not a static file. `serve.ts` renders it per request from the live registry;
`build.ts` writes it from the corpus at build time. The generated source embeds:

- the full precache URL list (index, icons, manifest, every `/docs/<slug>`), and
- a revision label = `engine VERSION` + FNV-1a hash of the sorted slug list.

Any registry edit (add/remove/reorder a doc) or engine upgrade changes the `sw.js` bytes, so the
browser installs the updated worker on the next navigation and re-precaches — **no manual
"refresh twice" dance**. Registration uses `{ updateViaCache: "none" }` so the worker script is
always revalidated. Both served and built output share one generator (`src/pwa.ts`).

### D5. Serve/build parity, and the existing purity rules hold

- `src/pwa.ts` is a **neutral module** (no serve-only imports) so `build.ts` can use it — the
  import-closure pin test (`admin_test.ts`) still passes.
- PWA endpoints are **GETs** and stay available under `READONLY=1`.
- The **admin layer and annotations never enter the SW** — they are serve-only by construction and
  are not precached, so they don't leak into offline or static output.
- **Portable doc downloads** strip the PWA head chrome (they must stay self-contained files).
- The SW intercepts the whole origin but deliberately **passes through non-GET and cross-origin
  requests**, so the `/api/` management surface and peer discovery are untouched.

### D6. Icons

`icon-192.png` and `icon-512.png` are derived from the existing `apple-touch-icon.png` (the
canonical 180px raster of the forest + § mark) upscaled with `sips`. This keeps visual identity
consistent with the current icon; the alternative (rasterizing `favicon.svg`) produced a white
background with a mis-rendered rect on this machine (QuickLook), so the known-good raster was used.
They ship embedded via the existing codegen pipeline (`scripts/gen-assets.ts` → `assets_gen.ts`),
like the favicon and apple-touch-icon, and are written by `build.ts`.

## What I deliberately did NOT do

- **No `site.jsonc` PWA overrides** (name/short_name/colors) — derived; extension point documented.
- **No maskable-purpose icon** — the favicon fills its frame; a maskable-safe variant is future
  work if the install tile matters on odd-shaped launchers.
- **No install-banner UI** — browsers surface install affordance natively for a manifest + SW.
- **No app-shell/SPA refactor** — the library is multi-page; the SW caches every page.
- **No change to `publish.jsonc` / the publish command** — the static build emits PWA files
  automatically; the publisher's sync command already copies the output dir.

## Security notes

Service workers and manifests only run in **secure contexts** — `localhost` (works), tailnet HTTPS
via `tailscale serve` (works), and HTTPS static hosts (works). The manifest and SW add no new
listening surface: they are just new GET routes on the already-exposed server. The SW passes through
all non-GET and cross-origin traffic, so the management API and peer discovery behavior are
unchanged.

## Assumptions to validate

1. **Network-first is the right freshness/offline tradeoff** for a local-first live-editing library.
   If you'd rather have first-load-from-cache (snappier, at the cost of a refresh to see edits),
   that's a one-line change in `src/pwa.ts`.
2. **Private docs belong in the offline cache on the live server.** The SW precaches what the server
   serves. If a machine should NOT have offline copies of private docs, that's a config decision for
   that content home (e.g. don't install / disable the SW there) — worth stating explicitly.
3. **Deriving the app identity from `site.jsonc` + the editorial palette is enough.** If you want a
   distinct app name/short name per machine, the `pwa` config block is the add.
4. **Upscaled 192/512 PNGs are acceptable** for the install tile. If pixel-perfect matters, a
   designer pass on the icon (or an SVG renderer) is the follow-up.
5. **Edited docs are eventually-consistent offline**: the offline copy is the last-served version
   until the next online visit refreshes it. Fine for a reading library; call it out if not.

## Verification

- `deno task test` — includes new `pwa_test.ts` (generation), `sw_behavior_test.ts` (the generated
  worker driven in a mocked SW runtime: install precaches everything, network-first online,
  cache fallback offline, cache-first assets, pass-through for API/cross-origin, stale-cache
  cleanup), plus serve/build/render endpoint tests.
- `deno fmt --check`, `deno lint`, `deno task doc-lint`, `deno publish --dry-run`.
- Manual: `deno task serve` → open `/` → install the app → open each doc → stop the server →
  everything still reads. `deno task build` → the output contains `manifest.webmanifest`, `sw.js`,
  `icon-192.png`, `icon-512.png`.
