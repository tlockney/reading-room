# Doc download — design

**Date:** 2026-07-07 · **Status:** approved for implementation

## Problem

There is no way to take a local copy of a library document out of the Reading Room. The served page
can be saved from the browser, but that copy carries server-tied chrome (breadcrumb nav,
`/favicon.svg` links, the admin layer's script tags) that is broken or meaningless outside the
server. This feature may later grow into a sharing function, so the downloadable form should be the
clean, reusable one.

## Decision

Add a serve-only download route that returns a **portable** copy of any doc:

- `GET /docs/<slug>/download` → the portable render, served with
  `Content-Disposition: attachment; filename="<slug>.html"`.
- A `↓ download` link in the doc page's breadcrumb cluster (admin layer, `assets/admin/admin.js`).
- Available under `READONLY=1` — downloading is a read, not a mutation.

### The portable render

A new `portableDoc(ctx, doc)` in `src/render.ts` (exported from `src/mod.ts`):

1. Resolve the source exactly like `transformDoc` (the `_migrated/<slug>.html` override when
   present, else `<workspace>/<src>`).
2. Strip every server-tied region: breadcrumb nav (`READING-ROOM-NAV`), favicon
   (`EDITORIAL-FAVICON`), admin (`RR-ADMIN`), and local slots (`RR-LOCAL-HEAD` / `RR-LOCAL-BODY`).
3. Heal the canonical editorial bundle in (strip-then-inject `EDITORIAL-HEAD` / `EDITORIAL-BODY`),
   so old docs with stale baked-in bundles download current.
4. Do **not** rewrite sibling links to `/docs/<slug>` — those are server paths; the source's own
   hrefs stay as authored.

The result is self-contained (the editorial bundle is inline) and environment-neutral (no
per-machine slot content), matching the "portable doc" concept `render.ts` already documents for the
favicon region.

## Alternatives rejected

- **Raw source passthrough** (what `buildDocPayload` sends): simplest, but can carry a stale
  editorial bundle or a baked-in admin region from a doc that was saved off a served page.
- **`transformDoc` output**: carries the breadcrumb nav, root-relative favicon links, and local
  slots — all broken or wrong when opened as a local file elsewhere.

## Invariants

- Serve-only: `build.ts` must not gain any download-related imports; the route lives in `serve.ts`
  only. `portableDoc` itself is a pure render function in `render.ts`, importable anywhere, but
  nothing in the build path calls it.
- No new permissions: the route reads the same files `transformDoc` reads.
- Future sharing reuses `portableDoc` as the payload builder.

## Testing

- `render_test.ts`: portable output strips nav/favicon/admin/slots, injects the canonical bundle
  (healing a stale one), leaves source hrefs alone, prefers the `_migrated` override.
- `serve_test.ts`: 200 + attachment header + filename for a known slug; body has editorial markers
  and none of the stripped regions; 404 for an unknown slug; still 200 under `READONLY=1`.
