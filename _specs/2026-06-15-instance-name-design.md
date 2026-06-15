# Reading Room — per-instance name — design

- Date: 2026-06-15
- Status: **approved** (design conversation complete; execute in this repo)
- Lands on the `worktree-peer-discovery` branch (tightly coupled to discovery; that branch is not
  yet merged)

> In `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Give each running instance a **clear, visible name** in the served UI, so you can tell instances
apart — both at a glance in the masthead and in cross-instance UI like the library switcher. The
name is a live-server concern: it is **dropped from static builds**. This closes the gap the
switcher mockup exposed — the discovery identity currently falls back to the generic `site.title`,
so every instance advertises an identical "The Reading Room".

## Decisions (from the design conversation)

1. **Dedicated field with a hostname fallback.** Add optional `instance` to `site.jsonc`. If unset,
   default to the **bare hostname** (`Deno.hostname()`, first dot-label only: `m4mini.local` →
   `m4mini`). Every instance is therefore identifiable with zero config; `instance` is the override.
2. **Eyebrow tag placement (serve-only).** The name rides the existing mono eyebrow:
   `REFERENCE LIBRARY · STUDIO`. No new masthead element. Shown on serve, absent from builds.
3. **The discovery identity advertises the name.** `/.well-known/reading-room.json` reports the
   instance name; the switcher shows it. This is what makes peers distinguishable.
4. **Build purity by signature, not by stripping.** `renderIndex` gains an optional `instanceName`;
   `build.ts` simply doesn't pass it, so the name can never reach static output.

## Component design

### Config — `src/config.ts`

- Extend `Site` with `instance?: string`. `parseSite` recognizes `instance` and validates it as a
  string (same shape as `title`).
- Add `resolveInstanceName(site: Site, hostnameFn: () => string = Deno.hostname): string`: returns
  `site.instance` when it is a non-empty string, else the bare hostname
  (`hostnameFn().split(".")[0]`). The `hostnameFn` parameter exists for testability — the suite
  passes a fake, so no test calls the real `Deno.hostname()`.
- This function is **only called on the serve path**; `build.ts`/`makeContext` never call it, so the
  build never needs `--allow-sys` and never learns the instance name.

### Masthead — `src/render.ts`

- `renderIndex(site: Site, corpus: Topic[], instanceName?: string): string` — when `instanceName` is
  a non-empty string, the eyebrow renders `${site.eyebrow} · ${instanceName}`; otherwise it renders
  `${site.eyebrow}` exactly as today. The eyebrow element is already mono-uppercased by CSS, so the
  name displays in the eyebrow's style with no markup change beyond the text.
- No new CSS. Scope is the **index masthead** only. Doc pages (breadcrumb nav, no masthead) are out
  of scope.

### Discovery identity — `src/discovery.ts`

- `PeerIdentity` changes from `{ title, version, topics, docs }` to
  `{ name, version, topics, docs }`. `title` is dropped (the library title does not distinguish
  instances — YAGNI).
- `buildIdentity(name: string, corpus: Topic[], version: string): PeerIdentity` takes the resolved
  instance name instead of `site`. `asIdentity` (the probe response narrower) validates `name`
  instead of `title`.
- The switcher (`assets/admin/admin.js`) renders `peer.identity.name` (falling back to `peer.name` /
  `peer.url` as today).

### Serve wiring — `src/serve.ts`

- Compute the instance name once per request path where needed:
  `const instanceName = resolveInstanceName(opts.ctx.site);`
- Index route: `renderIndex(opts.ctx.site, corpus, instanceName)` (was a two-arg call).
- Identity route: `json(buildIdentity(instanceName, corpus, VERSION))`.
- `build.ts` is unchanged: it keeps calling `renderIndex(ctx.site, corpus)` with no instance name.

### Permissions

- The serve path now calls `Deno.hostname()` (only when `instance` is unset), needing
  `--allow-sys=hostname`. Add it to the dev `serve` and `cli` tasks in `deno.jsonc` and to the
  documented installed-CLI permission union. `build`/`add-doc`/`publish` do not need it.

## Testing (no real hostname/tailnet needed)

- `resolveInstanceName`: returns `site.instance` when set; falls back to the injected hostname when
  unset/empty; strips the domain (`m4mini.local` → `m4mini`).
- `parseSite`: accepts a string `instance`; rejects a non-string `instance`.
- `renderIndex`: with an `instanceName`, the eyebrow contains `· STUDIO` (or the raw name pre-CSS);
  without it, the eyebrow is unchanged and contains no separator — pinning build purity at the
  render level.
- `buildIdentity`: returns `{ name, version, topics, docs }` from a name + corpus fixture.
- `probePeer`: a response with `name` validates; one missing `name` → null.
- Serve: `/.well-known/reading-room.json` returns `{ name: <resolved> }`; the served index masthead
  carries the instance tag; the **build** output (via `build()`/`renderIndex` two-arg) does not.
- Existing discovery/switcher tests updated from `title` → `name`.

## Build purity

`renderIndex`'s two-arg form (used by `build.ts`) emits no instance name; a `build_test.ts`/render
assertion pins that build output contains no `· <instance>` eyebrow tag. `discovery.ts` remains
serve-only (already pinned in `admin_test.ts`).

## Non-goals

- No doc-page instance badge (index masthead only).
- No new masthead CSS or element (reuse the eyebrow).
- No change to the content/engine split, the static build output, or the discovery mechanism — only
  what identity each instance advertises and shows.
