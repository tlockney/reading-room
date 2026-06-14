#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Build the Reading Room to STATIC files — for the remote publish.
 *
 * Writes exactly what the local server (serve.ts) renders dynamically, just
 * saved to disk: index.html + docs/<slug>/index.html. The per-slug directory
 * layout maps `/docs/<slug>` to its index document on S3 (no rewrite function
 * needed). Copy/sync those to publish. The local workflow does NOT need this —
 * `deno task serve` renders on the fly.
 *
 * The management layer is serve-only by construction: this file must never
 * import admin.ts or comments.ts (admin_test.ts pins the whole import
 * closure), and transformDoc strips any stale admin region from sources, so
 * static output carries no admin chrome and no annotations (build_test.ts
 * pins that on real output).
 *
 *   deno task build              # full corpus -> ./docs + ./index.html
 *   (publish.ts calls build() with outDir/sharedOnly for the remote subset)
 */
import { emptyDir, ensureDir } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";
import { injectLocalSlots, loadCorpus, loadSlots, renderIndex, transformDoc } from "./render.ts";
import type { Topic } from "./render.ts";
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { makeContext, resolveHome } from "./config.ts";
import type { RoomContext } from "./config.ts";
import { APPLE_TOUCH_ICON_B64, FAVICON_SVG } from "./assets_gen.ts";

/** The publish subset: only visibility:shared docs, then only non-empty topics. */
export function filterShared(corpus: Topic[]): Topic[] {
  return corpus
    .map((t) => ({ ...t, docs: t.docs.filter((d) => d.visibility === "shared") }))
    .filter((t) => t.docs.length > 0);
}

export interface BuildOptions {
  outDir?: string; // default ctx.root — today's layout (<root>/docs + <root>/index.html). <outDir>/docs is emptied.
  sharedOnly?: boolean; // default false — everything
}

export async function build(
  ctx: RoomContext,
  opts: BuildOptions = {},
): Promise<{ docs: number; topics: number }> {
  const outDir = opts.outDir ?? ctx.root;
  let corpus = await loadCorpus(ctx.registryPath);
  if (opts.sharedOnly) corpus = filterShared(corpus);
  const docsOut = join(outDir, "docs");
  console.log("Building Reading Room ->", outDir);
  await ensureDir(outDir);
  await emptyDir(docsOut);
  for (const t of corpus) {
    for (const d of t.docs) {
      const dir = join(docsOut, d.slug);
      await ensureDir(dir);
      await Deno.writeTextFile(join(dir, "index.html"), await transformDoc(ctx, corpus, t, d));
      console.log(`  doc  ${d.slug}/index.html`);
    }
  }
  await Deno.writeTextFile(
    join(outDir, "index.html"),
    injectLocalSlots(renderIndex(ctx.site, corpus), await loadSlots(ctx.root)),
  );
  // site icons ship embedded in the engine; the output dir gets its own copies
  await Deno.writeTextFile(join(outDir, "favicon.svg"), FAVICON_SVG);
  await Deno.writeFile(join(outDir, "apple-touch-icon.png"), decodeBase64(APPLE_TOUCH_ICON_B64));
  const total = corpus.reduce((s, t) => s + t.docs.length, 0);
  console.log(`  index.html  (${total} docs, ${corpus.length} topics)`);
  return { docs: total, topics: corpus.length };
}

export async function buildMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["root"] });
  await build(await makeContext(resolveHome(a.root)));
  console.log("Done.");
  return 0;
}

if (import.meta.main) {
  Deno.exit(await buildMain(Deno.args));
}
