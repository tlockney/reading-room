/**
 * Reading Room — macOS privacy (TCC) guards for the content home.
 *
 * macOS gates file access under external/network volumes (/Volumes/…), the
 * Desktop, Documents and Downloads folders, and iCloud Drive behind a per-app
 * consent prompt. A launchd agent has no UI to show that prompt, so its reads
 * of a content home in one of those places can stall instead of failing, and
 * the server never answers (tailscale serve then reports 502). Granting Full
 * Disk Access to the deno binary, or keeping the content home on a local,
 * unprotected path, avoids it. Pure helpers; no filesystem access here.
 */
import { join } from "jsr:@std/path@1";

/** Name the macOS privacy-protected area `path` is in, or undefined if none.
 * `homeDir` is the user's home ($HOME). */
export function protectedArea(path: string, homeDir: string): string | undefined {
  const under = (dir: string) => path === dir || path.startsWith(dir + "/");
  if (under("/Volumes")) return "an external or network volume";
  if (!homeDir) return undefined;
  for (const d of ["Desktop", "Documents", "Downloads"]) {
    if (under(join(homeDir, d))) return `the ${d} folder`;
  }
  if (under(join(homeDir, "Library", "Mobile Documents"))) return "iCloud Drive";
  return undefined;
}

/** How to unblock a launchd agent reading `home`: grant Full Disk Access to
 * `denoPath`, or move the content home somewhere unprotected. */
export function fullDiskAccessHint(home: string, denoPath: string): string {
  return [
    `  A launchd agent can't show macOS's privacy prompt, so reads of ${home} may hang.`,
    `  Grant Full Disk Access to ${denoPath} (the file behind it, if it is a symlink):`,
    "  System Settings → Privacy & Security → Full Disk Access → +, then Cmd-Shift-G to type the path.",
    "  Then restart the agent: launchctl kickstart -k gui/$(id -u)/local.reading-room",
    "  Re-grant after upgrading deno. Or move the content home to a local path such as",
    "  ~/.local/share/reading-room and re-run `reading-room agent install --root <dir>`.",
  ].join("\n");
}

/** Await `p`, calling `onSlow` once if it hasn't settled within `ms`. The
 * result (or rejection) of `p` passes through unchanged. */
export async function watchSlow<T>(p: Promise<T>, ms: number, onSlow: () => void): Promise<T> {
  const timer = setTimeout(onSlow, ms);
  try {
    return await p;
  } finally {
    clearTimeout(timer);
  }
}
