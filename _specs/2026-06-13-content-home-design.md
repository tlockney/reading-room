# Reading Room — content home + CLI — design

- Date: 2026-06-13
- Status: **approved** (design conversation complete; to be executed in this repo)
- Builds on, and amends, `2026-06-13-cli-distribution-design.md`

> Located in `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Stop tying a machine's Reading Room content to a hand-placed, per-host **git repo** whose location
the human and tools must each know. Instead, keep content in **one well-known local directory per
machine** — the _content home_ — that the installed `reading-room` CLI, the
`editorial-longform-html` skill, and any other tool can reliably resolve, serve from, and write
into.

Primary goal: **distinct, per-machine content servers** with one canonical place to add and update
content. A machine's content reflects that machine's role.

This layers on the installable CLI from `2026-06-13-cli-distribution-design.md`: the CLI is the
delivery vehicle; the content home is where it operates.

## Decisions (from the design conversation)

1. **Plain local directory — no git, no sync.** Sync between machines is explicitly **not** a goal
   now; it is a later, harder problem needing an as-yet-unidentified mechanism. Each machine is
   independent. The worktree-as-sibling constraint disappears with git.
2. **One library per machine.** The content home _is_ the library — `site.jsonc`, `registry.jsonc`,
   `_migrated/`, `comments/` live directly under it. A machine needing different content is a
   different machine. No multi-library-per-host container.
3. **Home-always resolution** (no cwd auto-detection). Precedence: `--root <dir>` flag →
   `$READING_ROOM_HOME` env → `${XDG_DATA_HOME:-~/.local/share}/reading-room`.
4. **`init` subcommand + lazy auto-create.** `reading-room init` scaffolds a starter home; write
   paths also lazily create missing structure so a fresh machine never hard-fails.

## Why the home is self-contained (key finding)

`transformDoc` (`src/render.ts`) resolves a doc's body from `<root>/_migrated/<slug>.html`
**first**, falling back to the scattered `join(ctx.workspace, doc.src)` only when that override is
absent. In the current registry all 9 entries already have a matching `_migrated/<slug>.html`, so
the override always wins and the scattered `src` is never read (its paths don't even resolve to the
real files here). Therefore a content home built around
`{ registry.jsonc, site.jsonc, _migrated/, comments/ }` is **fully self-contained** — it has no real
dependency on `dirname(root)`. The `workspace` field and scattered-`src` fallback become
**vestigial/legacy**: kept for back-compat, not relied upon.

## Relationship to the CLI spec — amendments

This design **amends** `2026-06-13-cli-distribution-design.md`:

- **Subcommands operate on the resolved home, not `Deno.cwd()`.** Each `*Main(args)` parses
  `--root`, calls `resolveHome`, and threads `makeContext(home)`.
- **The `init` open question is resolved: yes, `init` is in scope** and largely supersedes the
  "fresh repo" path of `convert-to-engine.sh`.
- **The launchd agent no longer needs a meaningful `WorkingDirectory`** — `reading-room serve`
  resolves the home internally. The agent just runs the binary.

Everything else in the CLI spec stands: the `cli` dispatcher, the `*Main` lift, generated
`version.ts`, the permission union for `deno install -g`, Option A (install) now / Option B
(compile) later, and back-compat of the four `./serve`-style exports.

**Build order:** build the dispatcher with home resolution baked into the `*Main` functions from the
start, rather than building cwd-based and changing it later.

## Component design

### Root resolution — `src/config.ts`

Add an exported resolver used only by the CLI/`*Main` layer:

```ts
/** Resolve the content home: explicit flag, else env, else XDG data dir. */
export function resolveHome(flagRoot?: string): string {
  if (flagRoot) return resolve(flagRoot);
  const env = Deno.env.get("READING_ROOM_HOME");
  if (env) return resolve(env);
  const xdg = Deno.env.get("XDG_DATA_HOME") ??
    join(Deno.env.get("HOME") ?? ".", ".local", "share");
  return join(xdg, "reading-room");
}
```

- **`makeContext(root = Deno.cwd())` keeps its signature.** The library API (`mod.ts`) and the
  entire test suite stay root-agnostic and untouched; only the CLI's _choice_ of root changes.
- `workspace = dirname(root)` stays as the vestigial scattered-`src` fallback — deprecated, not
  removed (smallest change). A one-line comment marks it legacy.
- Reads `HOME`/`XDG_DATA_HOME`/`READING_ROOM_HOME` from the env → the installed CLI's permission set
  must include these in `--allow-env` (extends the CLI spec's `PORT,READONLY` union to
  `PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME`).

### `init` subcommand + `ensureHome` — bootstrap

`reading-room init [--root <dir>]`, idempotent, never clobbers:

- create the home dir, `_migrated/`, `comments/`
- write a commented `site.jsonc` template **if absent** (title/eyebrow/lede/footer placeholders)
- write a minimal valid empty `registry.jsonc` **if absent** (exact empty shape confirmed against
  `src/registry.ts` during implementation)
- print the resolved home path

`ensureHome(home)` — a shared helper invoked at the top of every **write** path (`addDocMain`,
annotation-mutation handlers): creates the home dir + `_migrated/` + `comments/` + an empty
`registry.jsonc` if missing. `loadSite` already returns `DEFAULT_SITE` when `site.jsonc` is absent,
so identity needs no special handling. Net effect: a fresh machine can `reading-room add-doc …` with
zero prior setup; `init` is the guided path, not a prerequisite.

`init` is serve-independent and read/write only — it must not import `admin.ts`/`comments.ts`
mutation chrome beyond what is needed to create the empty directory.

### Engine-repo dev story

This repo stays its own first consumer. Dev tasks pass `--root .` so the current root
`registry.jsonc`/`_migrated/`/`comments/` keep working in place. Moving dev content into `example/`
remains the separate future cleanup CLAUDE.md already notes — **out of scope here**.

## Per-machine migration (operational, one-time per host)

1. `deno install -g … jsr:@tlockney/reading-room@<ver>/cli` (per the CLI spec).
2. `reading-room init` — creates `~/.local/share/reading-room`.
3. Move the old content repo's `registry.jsonc`, `site.jsonc`, `_migrated/`, `comments/`, `assets/`,
   `publish.jsonc` into the home.
4. Repoint the launchd agent to `reading-room serve` (drop `WorkingDirectory`); reinstall the agent.
5. Retire the per-host content git repo (or keep as a cold backup).

Vestigial `src` paths keep being ignored (overrides win), so **no registry rewrite is needed**.

## Conversion tooling

`convert-to-engine.sh` is largely superseded by `init`. Reduce it to a thin wrapper: run
`reading-room init`, then move existing content into the home, then print the install + agent hints.
Do **not** delete it outright — keep it as the documented migration entry point.

## Testing

- **`resolveHome` precedence:** flag > `READING_ROOM_HOME` > `XDG_DATA_HOME` > `~/.local/share`
  default, with a faked env. Asserts each tier and that a later tier is ignored when an earlier one
  is set.
- **`init`:** creates the expected structure; is idempotent; never clobbers an existing `site.jsonc`
  or `registry.jsonc`.
- **Lazy create:** `addDocMain` against a missing/empty home creates structure and files the doc;
  serving the home then renders it.
- **Back-compat:** existing suite stays green (explicit fixture roots); CLI-spec pins
  (`assets_gen_test`, `version.ts` pin, build-purity guards) hold.

## Docs to update

- **CLAUDE.md:** reverse the "engine runs against `Deno.cwd()`" contract → "engine runs against the
  resolved content home (`--root` → `$READING_ROOM_HOME` → XDG default)"; **remove the
  worktree-as-sibling gotcha** (no longer applies — self-contained, no git); reframe the two-repo
  model's "content repo (git, private)" → "content home (plain local directory)"; fold in the CLI
  spec's known-limitation replacement.
- **README:** install → `reading-room init` → home path + `$READING_ROOM_HOME` override; the
  `deno run jsr:.../cli` no-install fallback.

## Non-goals (YAGNI)

- No git, no cross-machine sync, no multi-library-per-machine.
- No removal of the scattered-`src` / `workspace` code (kept vestigial).
- No moving dev content into `example/` (separate future cleanup).
- No change to the content/engine split, `site.jsonc` schema, slots, the admin/annotations model, or
  the render pipeline — only _where_ the engine looks and _how_ it bootstraps.
