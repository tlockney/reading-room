/**
 * Bootstrap a content home. `ensureHome` lazily creates the directory layout +
 * an empty registry so write paths (add-doc, annotations) never hard-fail on a
 * fresh machine; `initMain` is the guided `reading-room init` that additionally
 * writes a commented site.jsonc template. Both are idempotent and never clobber
 * existing files.
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { ensureDir, exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { resolveHome } from "./config.ts";

/** Empty registry: a top-level JSON array. insertTopic/insertDoc edit it as text. */
const EMPTY_REGISTRY = "// Reading Room registry — topics → docs.\n" +
  "// Add documents with `reading-room add-doc`.\n[]\n";

/** Commented starter identity; every field optional (absent → DEFAULT_SITE). */
const SITE_TEMPLATE = `// Reading Room site identity. Every field is optional.
{
  // "title": "The Reading Room",
  // "eyebrow": "Reference Library",
  // "lede": "Every long-form document, gathered and grouped.",
  // "footer": ["Reference Library", "Local · Not for Distribution", "The Reading Room"]
}
`;

/** Create the home layout + an empty registry if missing. Safe to call on every write. */
export async function ensureHome(home: string): Promise<void> {
  await ensureDir(home);
  await ensureDir(join(home, "_migrated"));
  await ensureDir(join(home, "comments"));
  const registry = join(home, "registry.jsonc");
  if (!(await exists(registry))) await Deno.writeTextFile(registry, EMPTY_REGISTRY);
}

/** `reading-room init [--root <dir>]` — scaffold a home, including a site.jsonc template. */
export async function initMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["root"] });
  const home = resolveHome(a.root);
  await ensureHome(home);
  const site = join(home, "site.jsonc");
  if (!(await exists(site))) await Deno.writeTextFile(site, SITE_TEMPLATE);
  console.log(`Reading Room home ready: ${home}`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await initMain(Deno.args));
}
