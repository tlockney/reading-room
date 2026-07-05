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
