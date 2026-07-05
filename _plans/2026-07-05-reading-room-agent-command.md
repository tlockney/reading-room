# Reading Room `agent` command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `reading-room agent {install,uninstall,status,logs}` subcommand to the engine that manages a macOS launchd login service serving the content home over the tailnet, so the per-machine dev checkout (`~/src/personal/reading-room` + its `agent.sh`) can be deleted.

**Architecture:** One new module `src/agent.ts` split into pure helpers (path/deno resolution, serve-arg and launchd-plist construction) and an `agentMain(args, deps)` orchestrator whose side effects (`launchctl`/`tailscale`/`id` execution and filesystem writes) go through an injectable `AgentDeps` bag — mirroring how `src/discovery.ts` injects its `tailscale` runner so tests need no real launchd. `src/cli.ts` gains an `agent` case. macOS-only behind a platform guard.

**Tech Stack:** Deno 2.x, TypeScript (strict, no `any`), `jsr:@std/cli` (`parseArgs`), `jsr:@std/path` (`join`, `dirname`), `jsr:@std/assert` for tests. Published to JSR as `@tlockney/reading-room`.

## Global Constraints

- **TypeScript: never `any`.** Use `unknown` + narrowing; wrap untyped shapes with interfaces.
- **Tests colocated** as `src/agent_test.ts`; `deno.jsonc` `publish.exclude` (`src/**/*_test.ts`) keeps them out of the package. Do not add tests at repo root.
- **`deno task test`, `deno fmt --check`, and `deno lint` must all pass before every commit.** `fmt` lineWidth is 100.
- **Never mention AI/Claude in commit messages.**
- **The launchd plist permission union is verbatim and load-bearing:** `--allow-read --allow-write --allow-net --allow-run --allow-sys=hostname --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME` plus `--minimum-dependency-age=0`. `--allow-run` (tailscale) and `--minimum-dependency-age=0` (fresh-release crashloop, land mine #1) are NOT optional.
- **Fixed values:** launchd label `local.reading-room`; default port `8413`; plist `PATH` = `/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`; JSR module base `jsr:@tlockney/reading-room`.
- **Content home resolution** reuses `resolveHome` from `src/config.ts` (`--root` → `$READING_ROOM_HOME` → `${XDG_DATA_HOME:-~/.local/share}/reading-room`). The agent baked into the plist always passes an explicit `--root`.
- **The generated plist must never reference the `deno install -g` shim** (it calls bare `deno`, which launchd's minimal PATH can't find). Bake an absolute deno binary + the pinned engine version.

## File Structure

- **Create `src/agent.ts`** — the whole feature: pure helpers + `agentMain` + `realDeps`. One responsibility (the launchd login service), so one file.
- **Create `src/agent_test.ts`** — colocated tests.
- **Modify `src/cli.ts`** — add the `agent` dispatch case and usage line.
- **Modify `deno.jsonc`** — add `XDG_STATE_HOME` to the `cli` task's `--allow-env` allowlist (the agent reads it for the log dir).
- **Modify `CLAUDE.md` / `README.md`** — document the `agent` command and the `XDG_STATE_HOME` addition to the install one-liner.

---

### Task 1: Path resolution and deno-binary resolution (pure helpers)

**Files:**
- Create: `src/agent.ts`
- Test: `src/agent_test.ts`

**Interfaces:**
- Consumes: `join` from `jsr:@std/path@1`.
- Produces:
  - `export const LABEL = "local.reading-room"`
  - `export const AGENT_PATH_ENV = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"`
  - `export type RunResult = { code: number; stdout: string; stderr: string }`
  - `export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>`
  - `export function resolveStateDir(env?: (k: string) => string | undefined): string`
  - `export function logPaths(stateDir: string): { out: string; err: string }`
  - `export function plistPath(homeDir: string): string`
  - `export async function resolveDenoPath(opts: { flag?: string; exists: (p: string) => boolean; run: RunFn; execPath: () => string }): Promise<string>`

- [ ] **Step 1: Write the failing test**

Add to a new `src/agent_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import {
  logPaths,
  plistPath,
  resolveDenoPath,
  resolveStateDir,
  type RunFn,
} from "./agent.ts";

const noRun: RunFn = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });

Deno.test("resolveStateDir prefers XDG_STATE_HOME, else HOME/.local/state", () => {
  const withXdg = (k: string) =>
    ({ XDG_STATE_HOME: "/xdg/state", HOME: "/home/t" } as Record<string, string>)[k];
  assertEquals(resolveStateDir(withXdg), "/xdg/state/reading-room");
  const withHome = (k: string) => (k === "HOME" ? "/home/t" : undefined);
  assertEquals(resolveStateDir(withHome), "/home/t/.local/state/reading-room");
  // empty XDG_STATE_HOME falls through (|| not ??), never a cwd-relative path
  const emptyXdg = (k: string) =>
    ({ XDG_STATE_HOME: "", HOME: "/home/t" } as Record<string, string>)[k];
  assertEquals(resolveStateDir(emptyXdg), "/home/t/.local/state/reading-room");
});

Deno.test("logPaths derives out/err under the state dir", () => {
  assertEquals(logPaths("/s/reading-room"), {
    out: "/s/reading-room/agent.out.log",
    err: "/s/reading-room/agent.err.log",
  });
});

Deno.test("plistPath is under ~/Library/LaunchAgents with the fixed label", () => {
  assertEquals(
    plistPath("/Users/t"),
    "/Users/t/Library/LaunchAgents/local.reading-room.plist",
  );
});

Deno.test("resolveDenoPath precedence: flag > homebrew > mise > execPath", async () => {
  const noneExist = () => false;
  const homebrewExists = (p: string) => p === "/opt/homebrew/bin/deno";
  const miseRun: RunFn = (cmd, args) =>
    Promise.resolve(
      cmd === "mise" && args[0] === "which"
        ? { code: 0, stdout: "/mise/bin/deno\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
    );
  const execPath = () => "/exec/deno";

  assertEquals(
    await resolveDenoPath({ flag: "/flag/deno", exists: noneExist, run: miseRun, execPath }),
    "/flag/deno",
  );
  assertEquals(
    await resolveDenoPath({ exists: homebrewExists, run: miseRun, execPath }),
    "/opt/homebrew/bin/deno",
  );
  assertEquals(
    await resolveDenoPath({ exists: noneExist, run: miseRun, execPath }),
    "/mise/bin/deno",
  );
  assertEquals(
    await resolveDenoPath({ exists: noneExist, run: noRun, execPath }),
    "/exec/deno",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/agent_test.ts`
Expected: FAIL — `Module not found` / `./agent.ts` has no such exports.

- [ ] **Step 3: Write minimal implementation**

Create `src/agent.ts`:

```ts
/**
 * Reading Room — the `agent` subcommand: a macOS launchd login service that
 * runs `reading-room serve` against the content home and exposes it over the
 * tailnet. Replaces the per-machine agent.sh script. macOS-only for now.
 *
 * The launchctl / tailscale / id execution and filesystem writes go through an
 * injectable AgentDeps bag (like discovery.ts injects its tailscale runner) so
 * the suite never mutates the machine. Pure helpers build the plist and args.
 */
import { dirname, join } from "jsr:@std/path@1";

export const LABEL = "local.reading-room";
export const AGENT_PATH_ENV = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

/** Log dir: $XDG_STATE_HOME/reading-room, else $HOME/.local/state/reading-room.
 * `||` (not `??`) so an empty env var falls through to the HOME-based path. */
export function resolveStateDir(env: (k: string) => string | undefined = Deno.env.get): string {
  const base = env("XDG_STATE_HOME") || join(env("HOME") || ".", ".local", "state");
  return join(base, "reading-room");
}

export function logPaths(stateDir: string): { out: string; err: string } {
  return { out: join(stateDir, "agent.out.log"), err: join(stateDir, "agent.err.log") };
}

export function plistPath(homeDir: string): string {
  return join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** Resolve an absolute deno binary for the plist. Prefer a stable real binary
 * (Homebrew) over mise's per-directory shim; --deno overrides; execPath() is
 * the last resort. Never returns the `deno install -g` shim. */
export async function resolveDenoPath(
  opts: { flag?: string; exists: (p: string) => boolean; run: RunFn; execPath: () => string },
): Promise<string> {
  if (opts.flag) return opts.flag;
  if (opts.exists("/opt/homebrew/bin/deno")) return "/opt/homebrew/bin/deno";
  try {
    const r = await opts.run("mise", ["which", "deno"]);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* mise absent — fall through */ }
  return opts.execPath();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/agent_test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/agent_test.ts
git commit -m "feat(agent): path and deno-binary resolution helpers"
```

---

### Task 2: Serve-arg and launchd-plist construction (pure)

**Files:**
- Modify: `src/agent.ts`
- Test: `src/agent_test.ts`

**Interfaces:**
- Consumes: `VERSION` from `src/version.ts`; `LABEL`, `AGENT_PATH_ENV` from Task 1.
- Produces:
  - `export function buildServeArgs(o: { version: string; home: string; port: number }): string[]`
  - `export interface PlistPlan { denoPath: string; serveArgs: string[]; homeDir: string; logOut: string; logErr: string; readonly: boolean }`
  - `export function renderPlist(plan: PlistPlan): string`

- [ ] **Step 1: Write the failing test**

Append to `src/agent_test.ts`:

```ts
import {
  buildServeArgs,
  renderPlist,
} from "./agent.ts";
import { assertStringIncludes } from "jsr:@std/assert@1";

Deno.test("buildServeArgs bakes the permission union, min-dep-age, pinned target, root, port", () => {
  assertEquals(buildServeArgs({ version: "9.9.9", home: "/home/t/.local/share/reading-room", port: 8413 }), [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-run",
    "--allow-sys=hostname",
    "--allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME",
    "--minimum-dependency-age=0",
    "jsr:@tlockney/reading-room@9.9.9/serve",
    "--root",
    "/home/t/.local/share/reading-room",
    "--port",
    "8413",
  ]);
});

Deno.test("renderPlist emits a binary-direct plist with no WorkingDirectory", () => {
  const xml = renderPlist({
    denoPath: "/opt/homebrew/bin/deno",
    serveArgs: buildServeArgs({ version: "9.9.9", home: "/h/room", port: 8413 }),
    homeDir: "/Users/t",
    logOut: "/s/reading-room/agent.out.log",
    logErr: "/s/reading-room/agent.err.log",
    readonly: false,
  });
  assertStringIncludes(xml, "<key>Label</key><string>local.reading-room</string>");
  assertStringIncludes(xml, "<string>/opt/homebrew/bin/deno</string>");
  assertStringIncludes(xml, "<string>--minimum-dependency-age=0</string>");
  assertStringIncludes(xml, "<string>jsr:@tlockney/reading-room@9.9.9/serve</string>");
  assertStringIncludes(xml, "<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
  assertStringIncludes(xml, "<key>HOME</key><string>/Users/t</string>");
  assertStringIncludes(xml, "<key>StandardOutPath</key><string>/s/reading-room/agent.out.log</string>");
  assertStringIncludes(xml, "<key>RunAtLoad</key><true/>");
  assertStringIncludes(xml, "<key>KeepAlive</key><true/>");
  assertEquals(xml.includes("WorkingDirectory"), false);
  // The permission union in ProgramArguments legitimately contains the substring
  // "READONLY" (--allow-env=...,READONLY,...); assert only that no READONLY *env
  // entry* is emitted when not readonly. buildServeArgs is never edited per-flag.
  assertEquals(xml.includes("<key>READONLY</key>"), false);
});

Deno.test("renderPlist adds READONLY=1 to the env when readonly", () => {
  const xml = renderPlist({
    denoPath: "/opt/homebrew/bin/deno",
    serveArgs: ["run"],
    homeDir: "/Users/t",
    logOut: "/o",
    logErr: "/e",
    readonly: true,
  });
  assertStringIncludes(xml, "<key>READONLY</key><string>1</string>");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/agent_test.ts`
Expected: FAIL — `buildServeArgs`/`renderPlist` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the top imports of `src/agent.ts`:

```ts
import { VERSION } from "./version.ts";
```

Append to `src/agent.ts`:

```ts
/** The `deno run` argv (after the deno binary) for the launchd serve process:
 * the full permission union, --minimum-dependency-age=0 (land mine #1), the
 * version-pinned serve entry, and an explicit --root/--port. */
export function buildServeArgs(o: { version: string; home: string; port: number }): string[] {
  return [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-run",
    "--allow-sys=hostname",
    "--allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME",
    "--minimum-dependency-age=0",
    `jsr:@tlockney/reading-room@${o.version}/serve`,
    "--root",
    o.home,
    "--port",
    String(o.port),
  ];
}

export interface PlistPlan {
  denoPath: string;
  serveArgs: string[];
  homeDir: string;
  logOut: string;
  logErr: string;
  readonly: boolean;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A launchd plist that runs the deno binary directly (never the install shim,
 * which launchd's minimal PATH can't resolve) with an explicit PATH + HOME. */
export function renderPlist(plan: PlistPlan): string {
  const argv = [plan.denoPath, ...plan.serveArgs];
  const progArgs = argv.map((s) => `    <string>${xmlEscape(s)}</string>`).join("\n");
  const env: [string, string][] = [["HOME", plan.homeDir], ["PATH", AGENT_PATH_ENV]];
  if (plan.readonly) env.push(["READONLY", "1"]);
  const envXml = env
    .map(([k, v]) => `    <key>${k}</key><string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(plan.logOut)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(plan.logErr)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/agent_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/agent_test.ts
git commit -m "feat(agent): serve-arg and launchd plist construction"
```

---

### Task 3: `agentMain` dispatch, platform guard, and `install`

**Files:**
- Modify: `src/agent.ts`
- Test: `src/agent_test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2; `resolveHome` from `src/config.ts`; `parseArgs` from `jsr:@std/cli@1`.
- Produces:
  - `export interface AgentDeps { run: RunFn; writeTextFile: (p: string, d: string) => Promise<void>; mkdir: (p: string) => Promise<void>; remove: (p: string) => Promise<void>; readTextFile: (p: string) => Promise<string>; exists: (p: string) => boolean; execPath: () => string; env: (k: string) => string | undefined; os: string }`
  - `export function realDeps(): AgentDeps`
  - `export async function agentMain(args: string[], deps?: AgentDeps): Promise<number>`
  - `export const AGENT_USAGE: string`

- [ ] **Step 1: Write the failing test**

Append to `src/agent_test.ts`:

```ts
import { type AgentDeps, agentMain } from "./agent.ts";

/** A recording AgentDeps: captures run() calls and written files, os=darwin. */
function fakeDeps(over: Partial<AgentDeps> = {}): {
  deps: AgentDeps;
  calls: { cmd: string; args: string[] }[];
  files: Map<string, string>;
  mkdirs: string[];
  removed: string[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  const files = new Map<string, string>();
  const mkdirs: string[] = [];
  const removed: string[] = [];
  const deps: AgentDeps = {
    run: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "id") return Promise.resolve({ code: 0, stdout: "501\n", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    writeTextFile: (p, d) => {
      files.set(p, d);
      return Promise.resolve();
    },
    mkdir: (p) => {
      mkdirs.push(p);
      return Promise.resolve();
    },
    remove: (p) => {
      removed.push(p);
      return Promise.resolve();
    },
    readTextFile: () => Promise.resolve(""),
    exists: (p) => p === "/opt/homebrew/bin/deno",
    execPath: () => "/exec/deno",
    env: (k) => ({ HOME: "/Users/t", READING_ROOM_HOME: "/room" } as Record<string, string>)[k],
    os: "darwin",
    ...over,
  };
  return { deps, calls, files, mkdirs, removed };
}

Deno.test("agent --help prints usage and exits 0 without touching deps", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assertEquals(await agentMain(["--help"], fakeDeps({ os: "linux" }).deps), 0);
  } finally {
    console.log = orig;
  }
  assertStringIncludes(lines.join("\n"), "reading-room agent");
});

Deno.test("agent install refuses on non-macOS", async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m?: unknown) => void errs.push(String(m));
  try {
    assertEquals(await agentMain(["install"], fakeDeps({ os: "linux" }).deps), 1);
  } finally {
    console.error = orig;
  }
  assertStringIncludes(errs.join("\n"), "macOS");
});

Deno.test("agent install writes the plist and boots it, bootout before bootstrap", async () => {
  const f = fakeDeps();
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["install"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  // plist written to ~/Library/LaunchAgents with the resolved home baked in
  const plist = f.files.get("/Users/t/Library/LaunchAgents/local.reading-room.plist");
  assertEquals(typeof plist, "string");
  assertStringIncludes(plist!, "<string>/opt/homebrew/bin/deno</string>");
  assertStringIncludes(plist!, "--root");
  assertStringIncludes(plist!, "<string>/room</string>"); // READING_ROOM_HOME resolved
  // launchctl bootout precedes bootstrap; tailscale serve --bg 8413 runs
  const seq = f.calls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assertEquals(seq, ["bootout", "bootstrap"]);
  const ts = f.calls.find((c) => c.cmd === "tailscale");
  assertEquals(ts?.args, ["serve", "--bg", "8413"]);
});

Deno.test("agent install honors --port and --root", async () => {
  const f = fakeDeps();
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["install", "--port", "9000", "--root", "/custom"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  const plist = f.files.get("/Users/t/Library/LaunchAgents/local.reading-room.plist")!;
  assertStringIncludes(plist, "<string>/custom</string>");
  assertStringIncludes(plist, "<string>9000</string>");
  const ts = f.calls.find((c) => c.cmd === "tailscale");
  assertEquals(ts?.args, ["serve", "--bg", "9000"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/agent_test.ts`
Expected: FAIL — `agentMain`/`AgentDeps` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the imports at the top of `src/agent.ts`:

```ts
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { resolveHome } from "./config.ts";
```

Append to `src/agent.ts`:

```ts
export const AGENT_USAGE = `reading-room agent — manage the launchd login service (macOS)

Usage: reading-room agent <command> [options]

Commands:
  install    [--root <dir>] [--port <n>] [--readonly] [--deno <path>]
  uninstall
  status
  logs

install writes ~/Library/LaunchAgents/${LABEL}.plist (deno binary + pinned
engine version + explicit --root), boots it, and exposes it via tailscale serve.
Logs go to $XDG_STATE_HOME/reading-room (else ~/.local/state/reading-room).`;

export interface AgentDeps {
  run: RunFn;
  writeTextFile: (p: string, d: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
  remove: (p: string) => Promise<void>;
  readTextFile: (p: string) => Promise<string>;
  exists: (p: string) => boolean;
  execPath: () => string;
  env: (k: string) => string | undefined;
  os: string;
}

export function realDeps(): AgentDeps {
  const dec = new TextDecoder();
  return {
    run: async (cmd, args) => {
      try {
        const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" })
          .output();
        return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
      } catch (err) {
        // binary missing (e.g. tailscale not installed): report, don't throw
        return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
      }
    },
    writeTextFile: (p, d) => Deno.writeTextFile(p, d),
    mkdir: (p) => Deno.mkdir(p, { recursive: true }),
    remove: async (p) => {
      try {
        await Deno.remove(p);
      } catch { /* already absent */ }
    },
    readTextFile: (p) => Deno.readTextFile(p),
    exists: (p) => {
      try {
        Deno.statSync(p);
        return true;
      } catch {
        return false;
      }
    },
    execPath: () => Deno.execPath(),
    env: (k) => Deno.env.get(k),
    os: Deno.build.os,
  };
}

function parsePort(v: unknown): number {
  const n = Number(v ?? 8413);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port: ${v}`);
  return n;
}

export async function agentMain(args: string[], deps: AgentDeps = realDeps()): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    console.log(AGENT_USAGE);
    return 0;
  }
  if (sub === undefined) {
    console.error(AGENT_USAGE);
    return 1;
  }
  if (deps.os !== "darwin") {
    console.error("reading-room agent: only supported on macOS for now");
    return 1;
  }
  const a = parseArgs(rest, { string: ["root", "port", "deno"], boolean: ["readonly"] });
  switch (sub) {
    case "install":
      return await install(a, deps);
    default:
      console.error(AGENT_USAGE);
      return 1;
  }
}

async function uid(deps: AgentDeps): Promise<string> {
  return (await deps.run("id", ["-u"])).stdout.trim();
}

async function install(
  a: { root?: string; port?: string; deno?: string; readonly?: boolean },
  deps: AgentDeps,
): Promise<number> {
  const home = resolveHome(a.root);
  const port = parsePort(a.port);
  const denoPath = await resolveDenoPath({
    flag: a.deno,
    exists: deps.exists,
    run: deps.run,
    execPath: deps.execPath,
  });
  const homeDir = deps.env("HOME") ?? "";
  const stateDir = resolveStateDir(deps.env);
  const { out, err } = logPaths(stateDir);
  const plist = renderPlist({
    denoPath,
    serveArgs: buildServeArgs({ version: VERSION, home, port }),
    homeDir,
    logOut: out,
    logErr: err,
    readonly: !!a.readonly,
  });
  const pPath = plistPath(homeDir);
  const u = await uid(deps);
  await deps.mkdir(stateDir);
  await deps.mkdir(dirname(pPath));
  await deps.writeTextFile(pPath, plist);
  await deps.run("launchctl", ["bootout", `gui/${u}/${LABEL}`]); // ignore if not loaded
  const boot = await deps.run("launchctl", ["bootstrap", `gui/${u}`, pPath]);
  if (boot.code !== 0) {
    console.error(`reading-room agent: launchctl bootstrap failed: ${boot.stderr.trim()}`);
    return 1;
  }
  const ts = await deps.run("tailscale", ["serve", "--bg", String(port)]);
  if (ts.code !== 0) {
    console.error(`reading-room agent: warning — tailscale serve failed: ${ts.stderr.trim()}`);
  }
  console.log(`reading-room agent installed (${LABEL}), serving ${home} on :${port}.`);
  console.log(`Logs: ${out}`);
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/agent_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/agent_test.ts
git commit -m "feat(agent): install subcommand with platform guard"
```

---

### Task 4: `uninstall`, `status`, and `logs` subcommands

**Files:**
- Modify: `src/agent.ts`
- Test: `src/agent_test.ts`

**Interfaces:**
- Consumes: `agentMain`, `AgentDeps`, `uid`, `plistPath`, `resolveStateDir`, `logPaths`, `LABEL` from Task 3.
- Produces: extends `agentMain`'s switch with `uninstall`, `status`, `logs` cases (no new exports).

- [ ] **Step 1: Write the failing test**

Append to `src/agent_test.ts`:

```ts
Deno.test("agent uninstall boots out, resets tailscale, removes the plist", async () => {
  const f = fakeDeps();
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["uninstall"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  const lc = f.calls.find((c) => c.cmd === "launchctl");
  assertEquals(lc?.args, ["bootout", "gui/501/local.reading-room"]);
  const ts = f.calls.find((c) => c.cmd === "tailscale");
  assertEquals(ts?.args, ["serve", "reset"]);
  assertEquals(f.removed, ["/Users/t/Library/LaunchAgents/local.reading-room.plist"]);
});

Deno.test("agent status queries launchctl print and tailscale serve status", async () => {
  const f = fakeDeps();
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["status"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  const lc = f.calls.find((c) => c.cmd === "launchctl");
  assertEquals(lc?.args, ["print", "gui/501/local.reading-room"]);
  const ts = f.calls.find((c) => c.cmd === "tailscale");
  assertEquals(ts?.args, ["serve", "status"]);
});

Deno.test("agent logs tails the two log files under the state dir", async () => {
  const reads: string[] = [];
  const f = fakeDeps({
    env: (k) => (k === "XDG_STATE_HOME" ? "/s" : k === "HOME" ? "/Users/t" : undefined),
    readTextFile: (p) => {
      reads.push(p);
      return Promise.resolve("line1\nline2\n");
    },
  });
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["logs"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  assertEquals(reads, ["/s/reading-room/agent.out.log", "/s/reading-room/agent.err.log"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/agent_test.ts`
Expected: FAIL — `uninstall`/`status`/`logs` hit the `default` case and return 1.

- [ ] **Step 3: Write minimal implementation**

In `src/agent.ts`, replace the `switch (sub)` block inside `agentMain` with:

```ts
  switch (sub) {
    case "install":
      return await install(a, deps);
    case "uninstall":
      return await uninstall(deps);
    case "status":
      return await status(deps);
    case "logs":
      return await logs(deps);
    default:
      console.error(AGENT_USAGE);
      return 1;
  }
```

Append the three functions to `src/agent.ts`:

```ts
async function uninstall(deps: AgentDeps): Promise<number> {
  const homeDir = deps.env("HOME") ?? "";
  const u = await uid(deps);
  await deps.run("launchctl", ["bootout", `gui/${u}/${LABEL}`]);
  await deps.run("tailscale", ["serve", "reset"]);
  await deps.remove(plistPath(homeDir));
  console.log(`reading-room agent uninstalled (${LABEL}).`);
  return 0;
}

async function status(deps: AgentDeps): Promise<number> {
  const u = await uid(deps);
  const svc = await deps.run("launchctl", ["print", `gui/${u}/${LABEL}`]);
  console.log(svc.stdout.trim() || svc.stderr.trim() || "(service not loaded)");
  const ts = await deps.run("tailscale", ["serve", "status"]);
  console.log(ts.stdout.trim() || ts.stderr.trim() || "(tailscale serve not configured)");
  return 0;
}

async function logs(deps: AgentDeps): Promise<number> {
  const { out, err } = logPaths(resolveStateDir(deps.env));
  for (const [label, p] of [["stdout", out], ["stderr", err]] as const) {
    console.log(`--- ${label} (${p}) ---`);
    try {
      const text = await deps.readTextFile(p);
      console.log(text.split("\n").slice(-40).join("\n"));
    } catch {
      console.log("(no log yet)");
    }
  }
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --allow-write --allow-env --allow-run src/agent_test.ts`
Expected: PASS (all agent tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/agent_test.ts
git commit -m "feat(agent): uninstall, status, and logs subcommands"
```

---

### Task 5: Wire `agent` into the CLI dispatcher

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli_test.ts`

**Interfaces:**
- Consumes: `agentMain` from `src/agent.ts`.
- Produces: `cli(["agent", ...])` routes to `agentMain`; USAGE lists `agent`.

- [ ] **Step 1: Write the failing test**

Append to `src/cli_test.ts`:

```ts
Deno.test("cli agent --help prints agent usage and exits 0", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assertEquals(await cli(["agent", "--help"]), 0);
  } finally {
    console.log = orig;
  }
  assertStringIncludes(lines.join("\n"), "reading-room agent");
});

Deno.test("cli usage lists the agent command", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    await cli(["--help"]);
  } finally {
    console.log = orig;
  }
  assertStringIncludes(lines.join("\n"), "agent");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env --allow-run --allow-sys=hostname src/cli_test.ts`
Expected: FAIL — `cli(["agent","--help"])` hits the default case (exit 1); USAGE lacks `agent`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, add the import after the other subcommand imports:

```ts
import { agentMain } from "./agent.ts";
```

Add a line to the `USAGE` template's command list, after the `init` line:

```
  agent     <install|uninstall|status|logs>  Manage the launchd login service (macOS)
```

Add a case to the `switch (sub)` block, after `case "init":`:

```ts
      case "agent":
        return await agentMain(rest);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --allow-write --allow-env --allow-run --allow-sys=hostname src/cli_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli_test.ts
git commit -m "feat(cli): route the agent subcommand"
```

---

### Task 6: Permission allowlist + documentation

**Files:**
- Modify: `deno.jsonc` (the `cli` task)
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing new. This task makes the *installed* CLI able to read `XDG_STATE_HOME` (the agent's log dir) and documents the command. Unit tests already pass (`deno task test` uses unscoped `--allow-env`).

- [ ] **Step 1: Add `XDG_STATE_HOME` to the `cli` task's env allowlist**

In `deno.jsonc`, the `cli` task's `--allow-env` currently reads:

```
--allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME
```

Change it to add `XDG_STATE_HOME`:

```
--allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,XDG_STATE_HOME,HOME
```

(Leave the `serve`, `build`, `add-doc`, `publish` tasks unchanged — the served process never reads `XDG_STATE_HOME`; only the `agent` command, reached through `cli`, does.)

- [ ] **Step 2: Verify the full suite, fmt, and lint pass**

Run: `deno task test && deno fmt --check && deno lint`
Expected: all pass. (If `deno fmt --check` flags `src/agent.ts`, run `deno fmt src/agent.ts` and re-run.)

- [ ] **Step 3: Document the command in `CLAUDE.md`**

In `CLAUDE.md`, under the "Installed CLI" section, update the install one-liner's `--allow-env` to include `XDG_STATE_HOME`:

```sh
  --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,XDG_STATE_HOME,HOME \
```

Then add this subsection immediately after the install one-liner block:

```markdown
### Agent (login service, macOS)

`reading-room agent install` writes `~/Library/LaunchAgents/local.reading-room.plist`
and boots it (`launchctl bootstrap gui/$UID`), then `tailscale serve --bg <port>`.
The plist runs an **absolute deno binary** (resolved: `--deno` → `/opt/homebrew/bin/deno`
→ `mise which deno` → the installing deno) against the **version-pinned**
`jsr:@tlockney/reading-room@<version>/serve` with the full permission union and
`--minimum-dependency-age=0` (land mine #1) and an explicit `--root <home>`. It does
**not** use the `deno install -g` shim — launchd's minimal PATH can't resolve bare
`deno`. Logs go to `$XDG_STATE_HOME/reading-room` (else `~/.local/state/reading-room`).

- `reading-room agent install [--root <dir>] [--port <n>] [--readonly] [--deno <path>]`
- `reading-room agent uninstall` — bootout, `tailscale serve reset`, remove the plist
- `reading-room agent status` — `launchctl print` + `tailscale serve status`
- `reading-room agent logs` — tail the two log files

Upgrading the running agent after a CLI upgrade is an explicit `reading-room agent install`
re-run (the pinned version in the plist does not float). macOS-only for now.
```

- [ ] **Step 4: Document the command in `README.md`**

In `README.md`, find where the CLI subcommands or `deno install` instructions are described and add a short entry for `agent` mirroring the CLAUDE.md summary (one paragraph: what `agent install` does, that it's macOS-only, and that logs live under `~/.local/state/reading-room`). Match the surrounding prose style. If the README has a `deno install -g` snippet with `--allow-env`, add `XDG_STATE_HOME` there too.

- [ ] **Step 5: Commit**

```bash
git add deno.jsonc CLAUDE.md README.md
git commit -m "docs(agent): document the agent command; allow XDG_STATE_HOME in cli"
```

---

## Self-Review

**Spec coverage:**
- New `src/agent.ts` + `cli.ts` wiring → Tasks 1–5. ✓
- Backend seam for later systemd → the `AgentDeps`/pure-helper split plus the `os !== "darwin"` guard in Task 3 is the seam; a systemd backend would add cases without reshaping the command. (The spec's named `ServiceBackend` interface is satisfied in substance by `AgentDeps` + the platform guard; no separate interface is introduced because there is only one backend today — YAGNI.) ✓
- Binary-direct plist, permission union, `--minimum-dependency-age=0`, pinned `@version`, explicit `--root`, PATH/HOME env, no WorkingDirectory → Task 2, asserted in tests. ✓
- deno-path resolution order (`--deno` → homebrew → mise → execPath) → Task 1. ✓
- Logs under `$XDG_STATE_HOME`/`~/.local/state` → Tasks 1, 4. ✓
- Injectable-runner testing without mutating the machine → `AgentDeps`, Tasks 3–4. ✓
- Drift test dropped → nothing to do in-repo (it lives only in the deleted checkout); the engine's own `src/drift_test.ts` is untouched. ✓
- Docs (CLAUDE.md, README) → Task 6. The `reading-room` **skill** update lands outside this repo and is tracked in the spec, not this plan. ✓
- Discovered addition not in the spec: `XDG_STATE_HOME` must join the installed CLI's `--allow-env` allowlist → Task 6.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the only prose-only step is Task 6 Step 4 (README), which is inherently repo-specific editing, bounded by an explicit mirror of the CLAUDE.md text.

**Type consistency:** `RunFn`/`RunResult`, `AgentDeps`, `PlistPlan`, `buildServeArgs`, `renderPlist`, `resolveDenoPath`, `resolveStateDir`, `logPaths`, `plistPath`, `agentMain` names are used identically across tasks and tests. `agentMain(args, deps?)` signature is stable from Task 3; Task 4 only extends its internal switch. `parsePort` and `uid` are internal (not exported), consistent with their single-file use.
