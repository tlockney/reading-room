# Reading Room — engine repo guide for Claude Code sessions

This file orients a future session working in **this repo** (`tlockney/reading-room`, published to
JSR as `@tlockney/reading-room`). It explains the engine/consumer split, how the pieces fit, the
non-obvious land mines, and how to release. Read it before making changes — several of the gotchas
below have already cost a debugging session each.

## What this is, in one paragraph

The Reading Room is an editorially-styled library for long-form HTML documents: a registry of topics
→ docs, served live (with a browser management layer and anchored annotations) or built to static
files for remote publish. It began as a single tool that was **copied between machines and
hand-edited** for each environment (a personal library, a work library) — which meant every feature
had to be ported by hand between forks. It is now a **shared engine** (this repo, public, on JSR)
plus a per-machine **content home** that holds only content and local configuration. Features land
here once; every machine picks them up with a CLI upgrade. That migration is the whole point of the
current architecture — preserve it.

## The engine / content home model

- **Engine (this repo).** All code: rendering core, live server + management API, static builder,
  remote publisher, the `add-doc` CLI, the editorial CSS/JS bundle, and the admin UI bundle. Public,
  open source, published to JSR. The full test suite lives here.
- **Content home (per machine, a plain local directory).** Holds `registry.jsonc`, `_migrated/`
  documents, `comments/` annotation sidecars, `site.jsonc` identity, optional
  `assets/{head,body}-extra.html` slots, and optional `publish.jsonc`. No git, no sync (a later,
  separate concern with an as-yet-unidentified mechanism). One library per machine.

The content home never vendors engine code. The engine never hardcodes one machine's identity or
content. Anything that differs between machines is **configuration in the content home**, not a fork
of the engine. When adding a feature, ask: "is this engine behavior (goes here) or machine
specificity (goes in the content home as config)?"

## How the engine resolves a content home

The **library** (`src/mod.ts`, `makeContext`) builds a `RoomContext` from an explicit root (default
`Deno.cwd()`): the registry path, `_migrated/` dir, `comments/` dir, and the `Site` identity loaded
from `<root>/site.jsonc` (generic defaults if absent). `RoomContext` is threaded through `render` /
`build` / `serve` / `publish`.

The **CLI** (`src/cli.ts`) resolves the content home before calling into the library via
`resolveHome` (`src/config.ts`). Precedence: `--root <dir>` flag → `$READING_ROOM_HOME` env →
`${XDG_DATA_HOME:-~/.local/share}/reading-room`. There is no module-relative `ROOT` and no
cwd-auto-detection — do not reintroduce either; they would break the "CLI finds the home regardless
of where it is invoked" contract.

The primary interface is now the installed `reading-room <subcommand>` CLI (see "Installed CLI"
below). The four `./serve`-style exports remain as back-compatible direct-run / library targets:

- `jsr:@tlockney/reading-room/serve` — live server (127.0.0.1) + management API + admin layer
- `jsr:@tlockney/reading-room/build` — static build of the full corpus
- `jsr:@tlockney/reading-room/publish` — build the `visibility:shared` subset + run `publish.jsonc`
- `jsr:@tlockney/reading-room/add-doc` — register a standalone editorial doc (the
  `editorial-longform-html` skill calls this; keep its name and flags stable)

`src/mod.ts` is the library surface (`build`, `makeHandler`, `makeContext`, registry-edit and
comments functions, `renderIndex`, etc.) and also re-exports `EDITORIAL_HEAD` / `EDITORIAL_BODY` —
the canonical bundle strings that content-home drift tests pin against.

## The customization model (the heart of the migration)

Two mechanisms, both in the content home, both additive — there is deliberately **no override /
shadowing** of engine internals:

1. **`site.jsonc`** — masthead `title`, `eyebrow`, `lede`, and `footer` lines. Every field optional.
   This replaced the old per-fork `SITE` constant in `render.ts`.
2. **Additive slots** — `assets/head-extra.html` and `assets/body-extra.html` are injected into
   every page (served _and_ built) inside `RR-LOCAL-HEAD` / `RR-LOCAL-BODY` marked regions, with the
   same idempotent strip-then-inject + healing as the editorial bundle. This is where an environment
   puts local CSS, fonts, banners, etc.

The canonical editorial bundle (zoom + theme + mobile) **always** injects regardless of slots. This
is intentional: it keeps the skill-drift guarantee meaningful in every environment (see below). Do
not add an override path that lets a consumer replace the canonical bundle — that was explicitly
rejected in design.

## Land mines (each has already bitten)

1. **Deno 2.8+ quarantines packages published < ~6 days ago** (`--minimum-dependency-age`, default
   on). A freshly published engine version fails to resolve until it ages out — this crashlooped a
   consumer's launchd `serve` agent (502 over Tailscale) the day a release shipped. Consumer tasks
   therefore carry `--minimum-dependency-age 0`. It is safe: the engine is first-party and
   `deno.lock` pins exact versions. If you generate consumer tasks, include this flag. Symptom in
   logs: `newer than the specified minimum dependency date of <rolling now-6d>`.

2. **`deno fmt` formats HTML in Deno 2.x.** A repo-wide `deno fmt` will silently reformat
   byte-pinned content (the editorial partials, the vendored skill template, the generated
   `src/assets_gen.ts`, hand-formatted `registry.jsonc`, and source documents) and break the drift /
   pin tests. `deno.jsonc` `fmt.exclude` fences these off — keep it intact. Run `deno fmt` freely
   _because_ of that fence; never remove entries from it without moving the pinned content
   elsewhere.

3. **JSR can't read package-relative files at runtime.** The editorial partials, admin bundle, and
   site icons are embedded as string constants in `src/assets_gen.ts`, generated by
   `scripts/gen-assets.ts` (`deno task gen`). `assets/` is the editable source of truth;
   `assets_gen_test.ts` pins generated ↔ source so they cannot drift. After editing anything under
   `assets/`, run `deno task gen` and commit the regenerated file, or the pin test fails.

4. **JSR publish needs a one-time manual link.** The package must exist on jsr.io and have this
   GitHub repo linked in its settings, or OIDC publishing from CI fails with `actorNotAuthorized`.
   CI cannot create the package. This is already set up; only relevant if the package/repo link is
   ever recreated.

5. **The admin/management layer is serve-only by construction.** `src/build.ts` must never import
   `admin.ts` or `comments.ts`, and `transformDoc` strips any stale `RR-ADMIN` region from sources.
   This keeps annotations and management chrome out of static/published output. `admin_test.ts` and
   `build_test.ts` pin this — do not route admin injection through the build path.

6. **The annotate affordance must be driven by `selectionchange`, not `mouseup`.** Touch (iOS/iPadOS
   long-press) and keyboard selection never fire `mouseup`, so a mouseup-only fab is invisible on
   those. The fab also captures `range.cloneRange()` when shown, because tapping it collapses the
   live selection on touch before the click handler runs. (Fixed in 0.1.1; don't regress it back to
   mouseup.)

7. **Peer discovery shells `tailscale` — that is why serve carries `--allow-run`.** Do not remove
   that flag from the install snippet or the launchd agent; it is not incidental.

## Annotations & management (serve-only)

The live server injects an admin layer: browser "manage mode" (toggle review / visibility / remove a
doc) and anchored marginalia. Annotations are stored as `comments/<slug>.json` sidecars in the
content home (source HTML is never modified) using W3C-style text-quote anchoring (quote + prefix +
suffix; unresolved anchors degrade to "unanchored", never lost). `READONLY=1` disables all mutation
routes for a view-only exposure. None of this appears in static builds.

## Peer discovery (serve-only)

Each served instance advertises its identity at `GET /.well-known/reading-room.json` —
`{ name, version, topics, docs }` — available even under `READONLY=1`. `serve` discovers peers by
enumerating `tailscale status --json` plus any `seeds` (an optional array of base URLs in
`site.jsonc`), probing each candidate's `/.well-known/reading-room.json`, and exposing the live
results at `GET /api/peers`. The masthead renders those results as a library switcher so the user
can navigate between instances.

Each instance has a **name**: the `instance` field in `site.jsonc` (e.g. `"instance": "Studio"`),
falling back to the bare hostname (`Deno.hostname()`, first dot-label). The name is shown
**serve-only** as an eyebrow tag (`REFERENCE LIBRARY · STUDIO`) and is dropped from static builds
(the build path calls the two-arg `renderIndex` with no name). It is also the `name` field the
library switcher displays when showing peers.

Three invariants to preserve: (1) discovery is **serve-only** — `build.ts` must never import
`src/discovery.ts` (pinned in `admin_test.ts` alongside `admin.ts` / `comments.ts`); (2) the serve
path needs **`--allow-run`** (already in the installed-CLI permission union) because peer discovery
shells out to `tailscale`; (3) the serve path needs **`--allow-sys=hostname`** (already in the
permission union) because the hostname fallback calls `Deno.hostname()`. The tailscale call and HTTP
probe are dependency-injected, so the suite needs no real tailnet.

mDNS (for LAN-only hosts not on a tailnet) is a deferred Phase 2 source — not in this change. See
`_specs/2026-06-14-peer-discovery-design.md` for the design rationale.

## Skill relationship

The `editorial-longform-html` Claude skill authors standalone docs and bakes the same editorial
bundle into them. The skill template is pinned against the engine's exported `EDITORIAL_HEAD` /
`EDITORIAL_BODY` via a drift test (engine-side here; content homes may keep a skip-if-absent drift
test against the locally installed skill). If you change the editorial partials, expect to update
the skill template too — the drift test will tell you.

## Working conventions

- `deno task test` must pass before every commit; `deno fmt --check` and `deno lint` too (CI runs
  all three plus `deno publish --dry-run` on PRs). The CI Deno is `v2.x` (currently ahead of some
  local installs — lint rules can be stricter there than locally; trust CI).
- Tests are colocated next to the code they cover as `src/<name>_test.ts` (Deno convention); a
  `publish.exclude` keeps them out of the JSR package. Add new tests beside their module, not at the
  repo root.
- TDD where practical; the suite covers render injection, registry string-surgery, comments CRUD,
  the handler API (round-trips, 404s, `READONLY` 403s), build-purity guards, layout, anchors, the
  codegen pin, slot idempotency, `site.jsonc` loading, and an `example/` integration build.
- Keep changes minimal and match surrounding style. Never mention AI/Claude in commit messages.

## Releasing

1. Bump `version` in `deno.jsonc`.
2. Commit, tag `v<version>`, push the tag.
3. The `publish` workflow tests and runs `deno publish` (JSR OIDC, no token).
4. Per-machine upgrade: re-run `deno install -g -f` at the new version (see "Installed CLI" below).

## Installed CLI

Install once per machine:

```sh
deno install -g -f -n reading-room \
  --allow-read --allow-write --allow-net --allow-run --allow-sys=hostname \
  --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME \
  --minimum-dependency-age=0 \
  jsr:@tlockney/reading-room/cli
```

Version is per-machine ambient state — whatever is currently installed. Re-run with the new version
specifier and `-f` to upgrade. `reading-room init` bootstraps the content home if it doesn't exist
yet. The content home is resolved: `--root <dir>` → `$READING_ROOM_HOME` →
`${XDG_DATA_HOME:-~/.local/share}/reading-room`.

See `_specs/2026-06-13-cli-distribution-design.md` and `_specs/2026-06-13-content-home-design.md`
for the design rationale.

## Repo-specific notes

- This repo carries content (`registry.jsonc`, `_migrated/`, `comments/`) at the root so
  `deno task serve` works here for development (via `--root .`). A future change will move that
  content out and point dev tasks at `example/`.
- `docs/` and `index.html` at the root are **build artifacts** (`deno task build` output, gitignored
  and wiped each build). Never hand-edit them, and never put durable docs under `docs/`. Durable
  docs (specs, plans, this file) live at the root or in `_specs/` / `_plans/`.
- Site icons (`favicon.svg`, `apple-touch-icon.png`) are embedded via codegen; the build writes
  copies to the output root as artifacts.
