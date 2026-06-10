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
 *   deno task build
 */
import { emptyDir, ensureDir } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { DOCS_OUT, loadCorpus, renderIndex, ROOT, transformDoc } from "./render.ts";

const corpus = await loadCorpus();
console.log("Building Reading Room ->", ROOT);
await emptyDir(DOCS_OUT);
for (const t of corpus) {
  for (const d of t.docs) {
    const dir = join(DOCS_OUT, d.slug);
    await ensureDir(dir);
    await Deno.writeTextFile(join(dir, "index.html"), await transformDoc(corpus, t, d));
    console.log(`  doc  ${d.slug}/index.html`);
  }
}
await Deno.writeTextFile(join(ROOT, "index.html"), renderIndex(corpus));
const total = corpus.reduce((s, t) => s + t.docs.length, 0);
console.log(`  index.html  (${total} docs, ${corpus.length} topics)`);
console.log("Done.");
