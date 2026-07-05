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
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { resolveHome } from "./config.ts";
import { TAILSCALE_BINS } from "./discovery.ts";
import { VERSION } from "./version.ts";

/** Resolve an absolute tailscale binary the agent can invoke under launchd (and
 * over a non-interactive shell), where bare `tailscale` is often not on PATH.
 * Falls back to bare `tailscale` if none of the known paths exist. */
function resolveTailscale(exists: (p: string) => boolean): string {
  return TAILSCALE_BINS.find((b) => b.startsWith("/") && exists(b)) ?? "tailscale";
}

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
  sleep: (ms: number) => Promise<void>;
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
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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
  try {
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
  } catch (err) {
    console.error(`reading-room agent: ${err instanceof Error ? err.message : err}`);
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
  const home = resolveHome(a.root, deps.env);
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
  // bootout is asynchronous: an immediate bootstrap can lose the race with the
  // still-tearing-down old job and fail with "Bootstrap failed: 5: Input/output
  // error". Retry a few times, giving the old job time to fully unload.
  let boot = await deps.run("launchctl", ["bootstrap", `gui/${u}`, pPath]);
  for (let attempt = 1; boot.code !== 0 && attempt < 5; attempt++) {
    await deps.sleep(300);
    boot = await deps.run("launchctl", ["bootstrap", `gui/${u}`, pPath]);
  }
  if (boot.code !== 0) {
    console.error(
      `reading-room agent: launchctl bootstrap failed after retries: ${boot.stderr.trim()}`,
    );
    return 1;
  }
  const ts = await deps.run(resolveTailscale(deps.exists), ["serve", "--bg", String(port)]);
  if (ts.code !== 0) {
    console.error(`reading-room agent: warning — tailscale serve failed: ${ts.stderr.trim()}`);
  }
  console.log(`reading-room agent installed (${LABEL}), serving ${home} on :${port}.`);
  console.log(`Logs: ${out}`);
  return 0;
}

async function uninstall(deps: AgentDeps): Promise<number> {
  const homeDir = deps.env("HOME") ?? "";
  const u = await uid(deps);
  await deps.run("launchctl", ["bootout", `gui/${u}/${LABEL}`]);
  await deps.run(resolveTailscale(deps.exists), ["serve", "reset"]);
  await deps.remove(plistPath(homeDir));
  console.log(`reading-room agent uninstalled (${LABEL}).`);
  return 0;
}

async function status(deps: AgentDeps): Promise<number> {
  const u = await uid(deps);
  const svc = await deps.run("launchctl", ["print", `gui/${u}/${LABEL}`]);
  console.log(svc.stdout.trim() || svc.stderr.trim() || "(service not loaded)");
  const ts = await deps.run(resolveTailscale(deps.exists), ["serve", "status"]);
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
