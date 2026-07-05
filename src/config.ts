/**
 * Reading Room — per-environment configuration.
 *
 * The engine operates on a content root (the consumer repo, normally
 * Deno.cwd()). Site identity comes from <root>/site.jsonc; an absent file
 * means the generic defaults, so a bare content repo still serves. The CLI
 * resolves the content home directory via resolveHome().
 */
import { dirname, join, resolve } from "jsr:@std/path@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";

export interface Site {
  title: string;
  eyebrow: string;
  lede: string;
  footer: string[];
  seeds?: string[]; // optional discovery escape-hatch: base URLs of peers the auto-sources can't see
  instance?: string; // this instance's name; serve-only, advertised to peers. Unset → bare hostname.
}

export const DEFAULT_SITE: Site = {
  title: "The Reading Room",
  eyebrow: "Reference Library",
  lede: "Every long-form document, gathered and grouped. Browse by topic, " +
    "or jump straight to what you came for.",
  footer: ["Reference Library", "Local · Not for Distribution", "The Reading Room"],
};

/** Everything path- or identity-shaped the engine needs about one environment. */
export interface RoomContext {
  root: string; // the content repo
  workspace: string; // dirname(root) — scattered registry `src` paths resolve here
  registryPath: string;
  migratedDir: string;
  commentsDir: string;
  site: Site;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** Merge a parsed site.jsonc over the defaults; explain the first bad field. */
export function parseSite(raw: unknown): Site | string {
  if (typeof raw !== "object" || raw === null) return "site.jsonc must be a JSON object";
  const o = raw as Record<string, unknown>;
  const site = { ...DEFAULT_SITE };
  for (const key of Object.keys(o)) {
    if (key === "title" || key === "eyebrow" || key === "lede") {
      const v = o[key];
      if (typeof v !== "string") return `${key} must be a string`;
      site[key] = v;
    } else if (key === "footer") {
      if (!isStringArray(o.footer)) return "footer must be an array of strings";
      site.footer = o.footer;
    } else if (key === "instance") {
      if (typeof o.instance !== "string") return "instance must be a string";
      site.instance = o.instance;
    } else if (key === "seeds") {
      if (!isStringArray(o.seeds)) return "seeds must be an array of strings";
      site.seeds = o.seeds;
    } else {
      return `unknown field: ${key}`;
    }
  }
  return site;
}

export async function loadSite(root: string): Promise<Site> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(root, "site.jsonc"));
  } catch {
    return DEFAULT_SITE;
  }
  const site = parseSite(parseJsonc(text));
  if (typeof site === "string") throw new Error(`invalid site.jsonc: ${site}`);
  return site;
}

export async function makeContext(root: string = Deno.cwd()): Promise<RoomContext> {
  const abs = resolve(root);
  return {
    root: abs,
    workspace: dirname(abs),
    registryPath: join(abs, "registry.jsonc"),
    migratedDir: join(abs, "_migrated"),
    commentsDir: join(abs, "comments"),
    site: await loadSite(abs),
  };
}

/** The name this instance advertises and shows: site.instance if a non-empty
 * string, else the bare hostname (first dot-label). hostnameFn is injectable
 * so tests never call the real Deno.hostname(). Serve-only — build never calls
 * this, so the build needs no --allow-sys and never learns the name. */
export function resolveInstanceName(site: Site, hostnameFn: () => string = Deno.hostname): string {
  const explicit = site.instance?.trim();
  if (explicit) return explicit;
  return hostnameFn().split(".")[0];
}

/** Resolve the content home the CLI operates on: an explicit --root flag, else
 * $READING_ROOM_HOME, else ${XDG_DATA_HOME:-~/.local/share}/reading-room. The
 * library API (makeContext) stays root-agnostic; only the CLI uses this.
 * `env` is injectable (defaults to Deno.env.get) so callers with their own
 * dependency bag — e.g. agent.ts's AgentDeps — can resolve against it without
 * touching the real environment. */
export function resolveHome(
  flagRoot?: string,
  env: (k: string) => string | undefined = Deno.env.get,
): string {
  if (flagRoot) return resolve(flagRoot);
  const home = env("READING_ROOM_HOME");
  if (home) return resolve(home);
  // `||` (not `??`) so an empty-string env var falls through rather than
  // resolving a cwd-relative path like "reading-room".
  const xdg = env("XDG_DATA_HOME") ||
    join(env("HOME") || ".", ".local", "share");
  return join(xdg, "reading-room");
}
