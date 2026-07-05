# Fold the dev checkout into the engine: `reading-room agent` command — design

- Date: 2026-07-05
- Status: **proposal** (not yet approved; to be refined/executed in a session in this repo)
- Builds on `_specs/2026-06-13-cli-distribution-design.md` (the installable `reading-room` CLI)

> Located in `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Delete the per-machine dev checkout at `~/src/personal/reading-room` entirely. Everything it
uniquely provides moves into the engine as a new `reading-room agent` subcommand, so that operating
a machine's Reading Room becomes: install the CLI once, run `reading-room agent install`. This is
the engine/content-home philosophy this repo already commits to — _features land in the engine once;
every machine picks them up with a CLI upgrade_ — applied to the one piece (`agent.sh`) that was
still living as a per-machine script.

## Background: why the checkout can go

An inventory of `~/src/personal/reading-room` found it thin and mostly stale:

- **Load-bearing and unique — three things only:** `agent.sh` (launchd + Tailscale wiring), the
  version-pinning `deno.jsonc` task aliases, and a machine-level `drift_test.ts`.
- **Stale / duplicate — everything else:** its `registry.jsonc`, `_migrated/`, `comments/`, `docs/`,
  `index.html`, and icons. Every task runs with **no `--root`**, and `serve.ts` resolves the content
  home via `resolveHome(a.root)` (→ `--root` → `$READING_ROOM_HOME` →
  `${XDG_DATA_HOME:-~/.local/share}/reading-room`) — never cwd. So the checkout's own content is
  never served or built; it is a duplicate corpus that has already drifted from the real content
  home at `~/.local/share/reading-room`, exercised only by the checkout's own `smoke_test.ts`.

The engine already ships an installable unified `reading-room` CLI (`src/cli.ts` dispatches
`serve | build | add-doc | publish | init`; `deno install -g` documented in `CLAUDE.md`). So the
checkout's serve/build/add-doc/publish tasks add nothing but version pinning. The only reason the
tree must exist today is to host `agent.sh` and give `deno task serve` a `deno.jsonc` to run from —
both of which this change removes.

## Non-goals (YAGNI)

- **Linux / systemd support.** `agent.sh` is launchd-only, and the current agent runs on macOS. The
  `agent` command is macOS-only in this change; on other platforms `install`/`uninstall` exit with a
  clear "only supported on macOS for now" error. The code is structured behind a small backend seam
  so a systemd backend can be added later without reshaping the command.
- **The machine-level `drift_test.ts` is dropped, not ported.** It pins the installed engine's
  `EDITORIAL_*` bundle against the locally installed `~/.claude` skill. It is low-value,
  version-skewed (pins `@0.1.0` while the tasks are on `@0.3.2`), and structurally awkward for the
  engine repo to own (the engine cannot meaningfully test "the installed skill on this machine" in
  CI). The engine keeps its own repo-internal `src/drift_test.ts` (repo skill copy ↔ repo assets),
  which is the guarantee that actually matters.

## Design

### New module `src/agent.ts`, wired into `src/cli.ts`

Add `agent` to the `cli.ts` dispatcher alongside `serve | build | add-doc | publish | init`, and
update `--help`. `src/agent.ts` exports `async function agentMain(args: string[]): Promise<number>`
returning an exit code, matching the shape of `serveMain`. Subcommands:

| Subcommand  | Behavior                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `install`   | Resolve deno path, content home, port; generate the launchd plist; write it; `launchctl bootstrap gui/$UID`; `tailscale serve --bg <port>`. Idempotent: bootout the existing label first so reinstall cleanly replaces a prior job (including today's checkout-anchored one — same label). |
| `uninstall` | `launchctl bootout gui/$UID/<label>`; `tailscale serve reset`; remove the plist.                                                                                                                                                                                                           |
| `status`    | `launchctl print gui/$UID/<label>` (state/pid) + `tailscale serve status`.                                                                                                                                                                                                                 |
| `logs`      | `tail -n <N>` the two agent log files (default 40).                                                                                                                                                                                                                                        |

Label stays `local.reading-room` (so a reinstall replaces the current agent in place). Flags on
`install`: `--port <n>` (default 8413), `--root <dir>` (content home; else resolved via the standard
precedence and baked in explicitly — see below), `--readonly` (sets `READONLY=1` in the plist env),
`--deno <path>` (override the resolved deno binary).

### Backend seam (for later systemd)

`agentMain` selects a platform backend by `Deno.build.os`. Define a small interface — e.g.
`ServiceBackend { install(plan): Promise<void>; uninstall(): Promise<void>; status(): Promise<...>;
logPaths(): {out,err} }`
— with a `LaunchdBackend` implementation. On non-`darwin`, `agentMain` returns a non-zero exit with
the "macOS only" message. This is the seam; no systemd code is written now.

### Plist generation (the core change)

The generated plist must **not** reference the `deno install -g` shim (`~/.deno/bin/reading-room`).
That shim is `#!/bin/sh … exec deno run … "$@"` and calls **bare `deno` from PATH**; launchd boots
with a minimal PATH that excludes both mise shims and Homebrew, so a shim-based `ProgramArguments`
would fail with `deno: not found`. Instead, replicate the pattern the current live plist already
proves works: bake an absolute real `deno` binary and run the pinned JSR module directly, with an
explicit PATH.

`ProgramArguments` (all values resolved at install time):

```
<abs deno>
  run
  --allow-read --allow-write --allow-net --allow-run --allow-sys=hostname
  --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME
  --minimum-dependency-age=0
  jsr:@tlockney/reading-room@<engine-version>/serve
  --root <resolved-home>
  --port <port>
```

Rationale for each non-obvious piece:

- **Full permission union**, matching the documented installed-CLI union. `--allow-run` is required
  (peer discovery shells `tailscale`; land mine #7); `--allow-sys=hostname` for the instance-name
  fallback (`Deno.hostname()`).
- **`--minimum-dependency-age=0` is mandatory, not optional** (land mine #1). Deno 2.8+ quarantines
  packages published < ~6 days ago; without this flag a freshly released engine version fails to
  resolve and **crashloops the launchd `serve` agent** (a 502-over-Tailscale outage that has already
  happened once). It is safe here — the engine is first-party and `deno.lock` pins exact versions.
- **`@<engine-version>` is pinned** to the engine's current `version` (read from `deno.jsonc`) so
  the login agent doesn't float to latest on every boot; upgrading the agent is an explicit
  `agent install` re-run after a CLI upgrade. Per the CLI-distribution spec, agent version is
  knowingly per-machine ambient state.
- **`--root <resolved-home>` is baked explicitly.** `install` resolves the effective content home
  once (via `--root` flag → `$READING_ROOM_HOME` → `${XDG_DATA_HOME:-~/.local/share}/reading-room`,
  the same `resolveHome` precedence) and writes the absolute path into the args. This removes the
  `WorkingDirectory`-dependence the current plist implies and any ambiguity about cwd — the agent
  serves exactly the resolved home regardless of where it was installed from.

Other plist keys: `Label = local.reading-room`; `RunAtLoad = true`; `KeepAlive = true`;
`StandardOutPath` / `StandardErrorPath` → the log paths below; `EnvironmentVariables` sets
`HOME = <home dir>` and `PATH = /opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` (the proven minimal
PATH; the abs-deno arg means PATH only needs to cover deno's own subprocess lookups like
`tailscale`). No `WorkingDirectory`.

### deno-path resolution order (at install time)

1. `--deno <path>` flag, if given.
2. `/opt/homebrew/bin/deno` if it exists and is a real executable — preferred because it is a stable
   real binary immune to mise's per-directory version switching (this is what `agent.sh` chose).
3. `mise which deno` output, if mise is present.
4. The installing process's own resolved deno (`Deno.execPath()`).

If none resolve to a usable binary, `install` errors with guidance. The chosen path is written into
the plist verbatim.

### Log location

`${XDG_STATE_HOME:-$HOME/.local/state}/reading-room/agent.{out,err}.log`. `install` creates the
directory; `logs` tails these; `status` reports them. This replaces the checkout-relative
`.agent.{out,err}.log`.

## Testing

The `launchctl` / `tailscale` / `mise` / filesystem-probe calls are wrapped behind an **injectable
runner** (a `CommandRunner` interface, dependency-injected exactly as peer discovery already injects
its `tailscale` call and HTTP probe) so tests assert behavior without mutating the machine.
Following this repo's colocated-test convention (`src/agent_test.ts`, kept out of the package by
`publish.exclude`), cover the application logic:

- **Plist generation:** given (deno path, engine version, resolved home, port, readonly, log paths)
  → exact expected plist XML, including the permission union, `--minimum-dependency-age=0`, the
  pinned `@<version>/serve` target, `--root`, and the PATH/HOME env. This is the load-bearing logic.
- **deno-path resolution order:** each precedence tier selected given a stubbed runner/filesystem.
- **Platform guard:** non-`darwin` returns the expected non-zero exit and message.
- **Command construction** for `install`/`uninstall`/`status`/`logs`: assert the exact `launchctl` /
  `tailscale` / `tail` argv the runner is asked to execute (bootout-before-bootstrap ordering on
  install; reset on uninstall).

`deno task test`, `deno fmt --check`, and `deno lint` must pass before commit (CI also runs
`deno publish --dry-run`).

## Migration / cutover (run by Thomas on the live machine; not automatable from CI or a background job)

The launchd install and `tailscale serve` are live mutations of login agents on the host and cannot
be verified from CI or a background session. After the engine change is merged and a new version
released:

1. `deno install -g -f -n reading-room … jsr:@tlockney/reading-room@<new>/cli` (the full union from
   `CLAUDE.md`).
2. `reading-room agent install` — bootout the existing `local.reading-room`, write the new
   binary-direct plist, re-run `tailscale serve`.
3. `reading-room agent status` and hit the tailnet URL to confirm the swap.
4. `rm -rf ~/src/personal/reading-room`.

## Docs to update (in this change)

- **`README.md` / `CLAUDE.md` (engine):** document
  `reading-room agent {install,uninstall,status,
  logs}` and its flags; note the plist bakes an
  absolute deno + pinned version + `--root` and why (land mines #1 and #7).
- **The `reading-room` Claude skill (`~/.claude/skills/reading-room/SKILL.md`):** the
  three-directory story collapses to two (engine source repo + content home; the dev checkout is
  gone). The Operations table changes from `deno task serve` / `./agent.sh install` to
  `reading-room serve` / `reading-room agent install`, and "Adding a document" from
  `cd ~/src/personal/reading-room && deno task add-doc` to `reading-room add-doc`. (This skill edit
  lands outside the repo, so it is done as part of the same work but is not part of the engine PR.)

## What gets deleted

Nothing inside the engine repo is deleted by this change (the checkout is a separate, unversioned
directory). The engine PR only _adds_ `src/agent.ts` + `src/agent_test.ts`, the `cli.ts` wiring, and
doc updates. The `~/src/personal/reading-room` directory is removed by hand in cutover step 4, after
the new agent is verified running.

## Risks / open questions

- **Homebrew deno availability.** Resolution tier 2 assumes `/opt/homebrew/bin/deno` on the current
  machine (it exists today). The fallback tiers cover machines without it; `--deno` is the escape
  hatch.
- **First boot after a fresh release** still downloads/caches the pinned module over the network at
  launchd load — same as today, and why `--minimum-dependency-age=0` is baked in.
- **Whether `agent install` should require the global `reading-room` shim to be installed first.**
  It does not need it (the plist is binary-direct), but the interactive `reading-room serve` /
  `add-doc` convenience does. The install one-liner stays the documented prerequisite for
  interactive use; `agent install` itself only needs a resolvable deno.
