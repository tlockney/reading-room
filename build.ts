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
import { loadCorpus, renderIndex, ROOT, transformDoc } from "./render.ts";
import type { Topic } from "./render.ts";

/** The publish subset: only visibility:shared docs, then only non-empty topics. */
export function filterShared(corpus: Topic[]): Topic[] {
  return corpus
    .map((t) => ({ ...t, docs: t.docs.filter((d) => d.visibility === "shared") }))
    .filter((t) => t.docs.length > 0);
}

export interface BuildOptions {
  outDir?: string; // default ROOT — today's layout (./docs + ./index.html). <outDir>/docs is emptied.
  sharedOnly?: boolean; // default false — everything
  registryPath?: string; // default REGISTRY — tests inject a fixture
}

export async function build(opts: BuildOptions = {}): Promise<{ docs: number; topics: number }> {
  const outDir = opts.outDir ?? ROOT;
  let corpus = await loadCorpus(opts.registryPath);
  if (opts.sharedOnly) corpus = filterShared(corpus);
  const docsOut = join(outDir, "docs");
  console.log("Building Reading Room ->", outDir);
  await ensureDir(outDir);
  await emptyDir(docsOut);
  for (const t of corpus) {
    for (const d of t.docs) {
      const dir = join(docsOut, d.slug);
      await ensureDir(dir);
      await Deno.writeTextFile(join(dir, "index.html"), await transformDoc(corpus, t, d));
      console.log(`  doc  ${d.slug}/index.html`);
    }
  }
  await Deno.writeTextFile(join(outDir, "index.html"), renderIndex(corpus));
  if (outDir !== ROOT) {
    // a standalone publish dir needs the site icons alongside it
    for (const icon of ["favicon.svg", "apple-touch-icon.png"]) {
      await Deno.copyFile(join(ROOT, icon), join(outDir, icon));
    }
  }
  const total = corpus.reduce((s, t) => s + t.docs.length, 0);
  console.log(`  index.html  (${total} docs, ${corpus.length} topics)`);
  return { docs: total, topics: corpus.length };
}

if (import.meta.main) {
  await build();
  console.log("Done.");
}
