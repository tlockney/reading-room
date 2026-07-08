#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Register (and place) a standalone editorial doc into the Reading Room.
 *
 * The editorial-longform-html skill knows to look for this task: after
 * authoring a standalone doc, run `deno task add-doc` here to file it into the
 * library. The doc itself is unchanged (it carries the editorial bundle and
 * works off-disk); render.ts de-dupes the bundle on serve.
 *
 * ```sh
 * deno run -A jsr:@tlockney/reading-room/add-doc \
 *   --src <file.html> --topic <id> --title "..." --kind "..." \
 *   --desc "..." --foot-left "..." --foot-right "..." [--slug x] \
 *   [--visibility private|shared] [--review] \
 *   [--new-topic "§ 0N|id|Name|Short"]
 * ```
 *
 * The pure registry editors live in registry-edit.ts (shared with serve.ts's
 * management API) and are re-exported here for back-compat.
 *
 * @module
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { basename, join } from "jsr:@std/path@1";
import { copy, exists } from "jsr:@std/fs@1";
import { insertDoc, insertTopic } from "./registry-edit.ts";
import type { DocEntry } from "./registry-edit.ts";
import { resolveHome } from "./config.ts";
import { ensureHome } from "./init.ts";

export { insertDoc, insertTopic, slugExists } from "./registry-edit.ts";
export type { DocEntry, TopicEntry } from "./registry-edit.ts";

/**
 * `reading-room add-doc` entry (exported so cli.ts can call it): copy the
 * authored file into _migrated/ and register it. Returns the exit code.
 */
export async function addDocMain(args: string[]): Promise<number> {
  const a = parseArgs(args, {
    string: [
      "root",
      "src",
      "topic",
      "slug",
      "title",
      "kind",
      "desc",
      "foot-left",
      "foot-right",
      "visibility",
      "new-topic",
    ],
    boolean: ["review"],
    default: { visibility: "private" },
  });

  const ROOT = resolveHome(a.root); // the content home this doc is being filed into
  await ensureHome(ROOT);
  const REGISTRY_PATH = join(ROOT, "registry.jsonc");
  const MIGRATED = join(ROOT, "_migrated");

  if (!a.src) throw new Error("--src <file.html> is required");
  if (!(await exists(a.src))) throw new Error(`source not found: ${a.src}`);
  const html = await Deno.readTextFile(a.src);
  if (!/<body[^>]*>/i.test(html)) throw new Error(`source has no <body>: ${a.src}`);

  const slug = a.slug ?? basename(a.src).replace(/\.html?$/i, "");
  const visibility = a.visibility === "shared" ? "shared" : "private";
  const entry: DocEntry = {
    slug,
    title: a.title ?? slug,
    kind: a.kind ?? "Reference",
    desc: a.desc ?? "",
    footLeft: a["foot-left"] ?? "Reference",
    footRight: a["foot-right"] ?? "Reading Room",
    src: `${basename(ROOT)}/_migrated/${slug}.html`,
    visibility,
    ...(a.review ? { review: true } : {}),
  };

  // Place the authored file as the editorial override transformDoc checks first.
  await copy(a.src, join(MIGRATED, `${slug}.html`), { overwrite: true });

  let registry = await Deno.readTextFile(REGISTRY_PATH);
  if (a["new-topic"]) {
    const [num, id, name, short] = a["new-topic"].split("|");
    registry = insertTopic(registry, { num, id, name, short, docs: [entry] });
  } else {
    if (!a.topic) throw new Error("--topic <id> is required (or use --new-topic)");
    registry = insertDoc(registry, a.topic, entry);
  }
  await Deno.writeTextFile(REGISTRY_PATH, registry);
  console.log(`Added "${entry.title}" -> http://127.0.0.1:8413/docs/${slug}`);
  console.log(`Placed _migrated/${slug}.html ; run \`reading-room serve\` to view.`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await addDocMain(Deno.args));
}
