/**
 * Reading Room — the `agent` subcommand: a macOS launchd login service that
 * runs `reading-room serve` against the content home and exposes it over the
 * tailnet. Replaces the per-machine agent.sh script. macOS-only for now.
 *
 * The launchctl / tailscale / id execution and filesystem writes go through an
 * injectable AgentDeps bag (like discovery.ts injects its tailscale runner) so
 * the suite never mutates the machine. Pure helpers build the plist and args.
 */
import { join } from "jsr:@std/path@1";

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
