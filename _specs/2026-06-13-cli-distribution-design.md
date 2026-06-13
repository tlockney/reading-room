# Reading Room as an installable CLI — design proposal

- Date: 2026-06-13
- Status: **proposal** (not yet approved; to be refined/executed in a session in this repo)
- Supersedes the "known limitation / planned cli-dispatcher fix" noted in `CLAUDE.md`

> Located in `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Distribute the engine as an **installable `reading-room` CLI**, so a content repo invokes
`reading-room <subcommand>` instead of repeating `jsr:@tlockney/reading-room@<ver>/<entry>` across
four `deno task` lines. This collapses the version + permission duplication to a single per-machine
install, and is the natural shape for a tool that is conceptually "a command you run against a
content directory."

## Why this, and what we are knowingly trading away

The duplication that motivated this: every consumer repeats `@<version>` (and the permission flags)
across four task lines, so a version bump is a four-line edit per repo. Verified Deno constraints
that rule out the cheaper fixes (tested on 2.7.14 and 2.8.2):

- `deno run` never resolves its **target** through the import map — an alias is treated as a file
  path.
- A `jsr:` run target ignores any import-map version constraint (floats to latest).
- A committed `deno.lock` does pin an unversioned `jsr:` target, but bumping it is awkward (the lock
  accumulates versions; not `deno outdated`-managed).
- `deno task <name> <args>` **does** forward trailing args to the task command (verified) — relevant
  below.

**Decision rationale (from the design conversation).** The runtime-`deno task` model's distinctive
benefit is per-repo, in-git version pinning (reproducible; clone-anywhere with zero install; the
agent's behavior fully described by the content repo). At the real scale here — a handful of
single-owner machines, low velocity, no desire to run divergent versions — those benefits are
marginal, and the specific "different versions per repo" capability will not be used. The accepted
trade is that **version becomes per-machine ambient state**: upgrading is a per-machine chore, and a
stale machine (including the launchd agent, whose version becomes global state) silently runs old
behavior. At two or three machines this is manageable by hand. This is an eyes-open reversal of the
"no per-machine drift" property the extraction bought — acceptable because the drift is now of a
_pinned, published tool_, not a hand-edited fork.

## The `cli` dispatcher (prerequisite for every distribution mode)

This is the foundational engine change; the installed CLI, a `deno compile` binary, and even a plain
`deno run jsr:.../cli serve` all consume it. Do this first regardless of the distribution decision
below.

### New module `src/cli.ts`, new export `./cli`

- Export `async function cli(args: string[]): Promise<number>` returning an exit code.
- Under `import.meta.main`: `Deno.exit(await cli(Deno.args))`.
- Dispatch on `args[0]`: `serve | build | add-doc | publish`, plus `--help`/`-h` (usage to stdout,
  exit 0) and `--version`/`-V` (print version, exit 0). Unknown/missing subcommand → usage to
  stderr, exit 1.
- Each subcommand keeps parsing its own remaining args (serve: port arg + `PORT`/`READONLY` env;
  publish: `--dry-run`; add-doc: its existing flag set). `cli.ts` only routes; it does not
  re-implement per-command parsing.

### Refactor each entry point to expose a callable

Currently `serve.ts`, `build.ts`, `add-doc.ts`, `publish.ts` put their CLI behavior under
`if (import.meta.main)`. Lift each block into an exported function:

- `serve.ts` → `export function serveMain(args: string[]): Promise<number>`
- `build.ts` → `export function buildMain(args: string[]): Promise<number>`
- `add-doc.ts` → `export function addDocMain(args: string[]): Promise<number>`
- `publish.ts` → `export function publishMain(args: string[]): Promise<number>`

Keep the existing `if (import.meta.main)` guards, now calling the corresponding `*Main`. This is
**back-compatible**: the four existing entry-point exports (`./serve`, etc.) keep working as direct
run targets, so content repos pinned to older versions (e.g. the work repo on `@0.1.x`) are
unaffected. `cli.ts` imports the four `*Main` functions and dispatches.

### Surfacing the version

`deno.jsonc` is **not** in the published package (`publish.include` is
`["src/", "README.md",
"LICENSE"]`), so the CLI cannot read it at runtime. Two viable sources, in
preference order:

1. **Generated `src/version.ts`** — extend `scripts/gen-assets.ts` (or a sibling `gen` step) to emit
   `export const VERSION = "<deno.jsonc version>";`, committed and pinned by a test (same pattern as
   `assets_gen.ts`). Robust across `deno run`, `deno install`, and `deno compile`. **Recommended.**
2. `import.meta.url` parsing — when run from JSR the URL is
   `https://jsr.io/@tlockney/reading-room/<ver>/src/cli.ts`, so the version is extractable. Fails
   for `deno compile` / local runs. Use only as a fallback if (1) is undesirable.

## Permissions

`deno install -g` bakes a single permission set into the shim, applied to **every** invocation. The
union across subcommands:

| Subcommand | needs                               |
| ---------- | ----------------------------------- |
| serve      | read, write, net, env=PORT,READONLY |
| build      | read, write                         |
| add-doc    | read, write                         |
| publish    | read, write, run                    |

So the installed binary runs everything with the union:
`--allow-read --allow-write --allow-net
--allow-env=PORT,READONLY --allow-run`. Accept this for a
personal tool (it is broader than the per-task least-privilege the `deno task` flags gave — `build`
will have `--allow-run`/`--allow-net` available though it never uses them). Document it. (A future
`deno compile` per-subcommand split could restore least-privilege, but that is out of scope.)

## Distribution: choose in the repo session

Both options consume the same `./cli` entry; they are not mutually exclusive.

### Option A — `deno install -g` (recommended starting point)

```
deno install -g -f -n reading-room \
  --allow-read --allow-write --allow-net --allow-env=PORT,READONLY --allow-run \
  --minimum-dependency-age=0 \
  jsr:@tlockney/reading-room@<ver>/cli
```

- **Pros:** one command; only Deno required; resolves + pins at install time (so the always-on agent
  never hits the Deno 2.8 `--minimum-dependency-age` quarantine at _runtime_ — resolution already
  happened). Explicit `@<ver>` pins; omit it to float to latest at install.
- **Cons:** requires Deno on each machine; permission union (above); version is ambient/per-machine.
- **Upgrade:** re-run with `-f` at the new version. `--minimum-dependency-age=0` is needed here too
  if installing a release younger than the quarantine window.

### Option B — `deno compile` standalone binary (later, if wanted)

```
deno compile -A -o reading-room jsr:@tlockney/reading-room@<ver>/cli
```

- **Pros:** no Deno needed; true standalone; `brew upgrade`-style UX via a tap. The embedded-asset
  codegen (`assets_gen.ts`) already means no runtime file reads, so the binary is self-contained.
- **Cons:** per-OS/arch builds (at minimum `darwin-arm64`; add others as needed); larger artifacts;
  a release pipeline to build + attach binaries on tag, plus a Homebrew tap to maintain.
- **CI:** extend the tag-triggered `publish` workflow to `deno compile` per target and attach to the
  GitHub release; optionally bump a `homebrew-tap` formula.

**Recommendation:** ship Option A immediately (zero new infrastructure). Add Option B only if/when a
Deno-free machine or a `brew` workflow is actually wanted.

## Consumer shape after the CLI

A content repo's `deno.jsonc` keeps the task **names** (preserves the `editorial-longform-html`
skill's `deno task add-doc` integration and muscle memory) but delegates to the installed binary:

```jsonc
{
  "tasks": {
    "serve": "reading-room serve",
    "build": "reading-room build",
    "add-doc": "reading-room add-doc",
    "publish": "reading-room publish"
  }
}
```

- No `@version` anywhere in the content repo — that is the point (version is the installed
  binary's).
- `site.jsonc`, `registry.jsonc`, `_migrated/`, `comments/`, slots, `publish.jsonc` are unchanged.
- The content repo no longer carries the engine in its `deno.lock` (nothing `deno run jsr:`s it from
  the repo). Consistent with per-machine versioning.
- **No-install fallback** to document:
  `deno run -A jsr:@tlockney/reading-room@<ver>/cli <subcommand>` works on a machine without the
  binary (e.g. a fresh checkout, CI).

### launchd agent (`agent.sh`)

- `ProgramArguments` changes from `deno task serve` to the resolved binary, e.g.
  `<HOME>/.deno/bin/reading-room serve`, with `WorkingDirectory` = the content repo (unchanged).
- `agent.sh` should resolve the binary (`command -v reading-room` ||
  `$HOME/.deno/bin/reading-room`), mirroring how it already resolves `deno`/`tailscale`.
- `--minimum-dependency-age` drops out of the agent path entirely (resolution is at install time).
- **Behavioral note to document:** the running server's version is now whatever is globally
  installed; a `deno install -g -f` to a new version changes the agent on its next restart, with no
  change to the content repo. This is the accepted trade above.

## Conversion tooling

Update `convert-to-engine.sh` (the migration script): generate CLI-style tasks (above), drop the
per-task version pins and `--minimum-dependency-age 0`, and **print the one-time install command**
(Option A) at the end. Keep emitting the `agent.sh` that invokes the binary. Optionally add a
preflight that checks `command -v reading-room` and prints the install line if missing.

## Testing

- **`cli.ts` dispatch:** `cli(["build"])` builds against a fixture cwd (reuse the existing
  fixture-root helpers); `cli(["bogus"])` → nonzero exit + usage on stderr; `cli(["--version"])`
  prints `VERSION`; `cli(["--help"])` prints usage. (Drive via a temp cwd; assert exit codes.)
- **Lifted `*Main` functions:** smoke tests for at least `buildMain` and `serveMain` (the latter via
  `makeHandler`, as today).
- **`version.ts` pin test:** generated `VERSION` equals `deno.jsonc` `version` (same shape as
  `assets_gen_test.ts`).
- **Back-compat:** the existing entry-point tests stay green (the four `./serve`-style targets still
  run).
- If Option B: a CI step that `deno compile`s the cli and runs `--version`.

## Rollout order (for the repo session)

1. Lift each entry's `import.meta.main` block into an exported `*Main(args)`; guards call them; add
   smoke tests. (Four small, independently-committable refactors.)
2. Add `src/version.ts` generation + pin test.
3. Add `src/cli.ts` + the `./cli` export in `deno.jsonc`; dispatch + `--help`/`--version`; tests.
4. Ship **0.2.0** (additive, non-breaking — new feature, existing entries intact).
5. `deno install -g …@0.2.0/cli` on the machine(s); verify `reading-room serve` from a content dir.
6. Convert each content repo's `deno.jsonc` tasks to `reading-room <subcommand>`; update `agent.sh`
   - the launchd plist; reinstall the agent.
7. Update `convert-to-engine.sh` to emit CLI-style tasks + the install hint.
8. Update `README.md` and `CLAUDE.md` to describe the installed-CLI model as the primary interface,
   with `deno run jsr:.../cli` as the no-install fallback. Replace the "known limitation" section in
   `CLAUDE.md`.

## Open questions to resolve in the session

- **Option A only, or also B?** Recommend A now; defer B.
- **New subcommands?** An `init` to scaffold a content repo (`site.jsonc` + `registry.jsonc` +
  `_migrated/` + tasks) would subsume much of `convert-to-engine.sh`'s "fresh repo" path. Possible
  scope expansion; decide separately.
- **Deprecate the four `./serve`-style exports** eventually, or keep them indefinitely as the
  library/runtime surface? (Keeping them is free and preserves back-compat + the `deno run jsr:`
  fallback.)
- **Permission union** acceptable, or worth a `deno compile` per-subcommand split for least
  privilege later?
- **Version source:** confirm generated `version.ts` over `import.meta.url` parsing.

## Non-goals

- Not changing the content/engine split, `site.jsonc`, slots, the admin/annotations model, or the
  render pipeline — only how the engine is invoked.
- Not a private-registry or multi-tenant story.
- Not removing the JSR package or the library exports (`mod.ts`) — the CLI is additive on top.
