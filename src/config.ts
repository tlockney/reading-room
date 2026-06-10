/**
 * Reading Room — per-environment configuration.
 *
 * The engine operates on a content root (the consumer repo, normally
 * Deno.cwd()). Site identity comes from <root>/site.jsonc; an absent file
 * means the generic defaults, so a bare content repo still serves.
 */
import { dirname, join, resolve } from "jsr:@std/path@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";

export interface Site {
  title: string;
  eyebrow: string;
  lede: string;
  footer: string[];
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
