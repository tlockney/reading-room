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
plus thin per-environment **content repos** that hold only content and local configuration. Features
land here once; every environment picks them up with a version bump. That migration is the whole
point of the current architecture — preserve it.

## The two-repo model

- **Engine (this repo).** All code: rendering core, live server + management API, static builder,
  remote publisher, the `add-doc` CLI, the editorial CSS/JS bundle, and the admin UI bundle. Public,
  open source, published to JSR. The full test suite lives here.
- **Content repo (per environment, private).** Holds `registry.jsonc`, `_migrated/` documents,
  `comments/` annotation sidecars, `site.jsonc` identity, optional `assets/{head,body}-extra.html`
  slots, optional `publish.jsonc`, and a `deno.jsonc` whose tasks invoke the engine via
  `jsr:@tlockney/reading-room@<ver>/<entry>`. See `example/` for the canonical shape.

A content repo never vendors engine code. The engine never hardcodes one environment's identity or
content. Anything that differs between environments is **configuration in the content repo**, not a
fork of the engine. When adding a feature, ask: "is this engine behavior (goes here) or environment
specificity (goes in the content repo as config)?"

## How the engine resolves an environment

Every entry point treats `Deno.cwd()` as the content root and builds a `RoomContext` from it
(`src/config.ts`): the registry path, `_migrated/` dir, `comments/` dir, and the `Site` identity
loaded from `<root>/site.jsonc` (generic defaults if absent). `RoomContext` is threaded through
`render` / `build` / `serve` / `publish`. There is no module-relative `ROOT` anymore — do not
reintroduce one; it would break the "engine runs against the consumer's cwd" contract.

Entry points (`deno.jsonc` `exports`, all operate on cwd):

- `jsr:@tlockney/reading-room/serve` — live server (127.0.0.1) + management API + admin layer
- `jsr:@tlockney/reading-room/build` — static build of the full corpus
- `jsr:@tlockney/reading-room/publish` — build the `visibility:shared` subset + run `publish.jsonc`
- `jsr:@tlockney/reading-room/add-doc` — register a standalone editorial doc (the
  `editorial-longform-html` skill calls this; keep its name and flags stable)

`src/mod.ts` is the library surface (`build`, `makeHandler`, `makeContext`, registry-edit and
comments functions, `renderIndex`, etc.) and also re-exports `EDITORIAL_HEAD` / `EDITORIAL_BODY` —
the canonical bundle strings that content-repo drift tests pin against.

## The customization model (the heart of the migration)

Two mechanisms, both in the content repo, both additive — there is deliberately **no override /
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

## Annotations & management (serve-only)

The live server injects an admin layer: browser "manage mode" (toggle review / visibility / remove a
doc) and anchored marginalia. Annotations are stored as `comments/<slug>.json` sidecars in the
content repo (source HTML is never modified) using W3C-style text-quote anchoring (quote + prefix +
suffix; unresolved anchors degrade to "unanchored", never lost). `READONLY=1` disables all mutation
routes for a view-only exposure. None of this appears in static builds.

## Skill relationship

The `editorial-longform-html` Claude skill authors standalone docs and bakes the same editorial
bundle into them. The skill template is pinned against the engine's exported `EDITORIAL_HEAD` /
`EDITORIAL_BODY` via a drift test (engine-side here; content repos keep a skip-if-absent drift test
against the locally installed skill). If you change the editorial partials, expect to update the
skill template too — the drift test will tell you.

## Working conventions

- `deno task test` must pass before every commit; `deno fmt --check` and `deno lint` too (CI runs
  all three plus `deno publish --dry-run` on PRs). The CI Deno is `v2.x` (currently ahead of some
  local installs — lint rules can be stricter there than locally; trust CI).
- TDD where practical; the suite covers render injection, registry string-surgery, comments CRUD,
  the handler API (round-trips, 404s, `READONLY` 403s), build-purity guards, layout, anchors, the
  codegen pin, slot idempotency, `site.jsonc` loading, and an `example/` integration build.
- Keep changes minimal and match surrounding style. Never mention AI/Claude in commit messages.
- Content repos must use git worktrees as **siblings** (not nested inside the repo): a registry's
  `src` paths resolve relative to the repo's parent directory, so a nested worktree resolves them
  wrong.

## Releasing

1. Bump `version` in `deno.jsonc`.
2. Commit, tag `v<version>`, push the tag.
3. The `publish` workflow tests and runs `deno publish` (JSR OIDC, no token).
4. Consumers upgrade by bumping their pinned version (today: one edit per engine task line — see the
   known limitation below).

## Known limitation / planned work

**Version duplication in consumer tasks.** Each consumer repeats `@<version>` across its four engine
task lines, so a bump is a four-line edit per repo. This is a Deno constraint, verified on 2.7 and
2.8: `deno run` never resolves its _target_ through the import map (an alias is treated as a file
path), and a `jsr:` run target ignores any import-map version constraint (floats to latest). A
committed `deno.lock` does pin an unversioned `jsr:` target, but bumping it is awkward (the lock
accumulates versions; it isn't `deno outdated`-managed). A bare-key import-map entry _does_ resolve
subpath **module imports** cleanly.

The intended fix: add a `./cli` export here that dispatches `serve|build|add-doc|publish` (lift each
entry's `import.meta.main` block into an exported function the dispatcher calls). Then a consumer
runs a one-line `rr.ts` wrapper
(`import { cli } from "@tlockney/reading-room/cli"; await
cli(Deno.args)`) and pins the version once
in its `imports` map, managed by `deno add` / `deno outdated`. Not yet implemented.

## Repo-specific notes

- This repo is its own first consumer: it carries content (`registry.jsonc`, `_migrated/`,
  `comments/`) at the root so `deno task serve` works here for development. A future change will
  move that content out and point dev tasks at `example/`.
- `docs/` and `index.html` at the root are **build artifacts** (`deno task build` output, gitignored
  and wiped each build). Never hand-edit them, and never put durable docs under `docs/`. Durable
  docs (specs, plans, this file) live at the root or in `_specs/` / `_plans/`.
- Site icons (`favicon.svg`, `apple-touch-icon.png`) are embedded via codegen; the build writes
  copies to the output root as artifacts.
