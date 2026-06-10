#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Register (and place) a standalone editorial doc into the Reading Room.
 *
 * The editorial-longform-html skill knows to look for this task: after
 * authoring a standalone doc, run `deno task add-doc` here to file it into the
 * library. The doc itself is unchanged (it carries the editorial bundle and
 * works off-disk); render.ts de-dupes the bundle on serve.
 *
 *   deno task add-doc --src <file.html> --topic <id> --title "..." --kind "..." \
 *     --desc "..." --foot-left "..." --foot-right "..." [--slug x] \
 *     [--visibility private|shared] [--review] \
 *     [--new-topic "§ 0N|id|Name|Short"]
 *
 * The pure insertDoc/insertTopic functions edit registry.jsonc by targeted
 * string surgery so the file's comments and hand-formatting survive (a
 * parse-and-reserialize round-trip would strip them).
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { basename, dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { copy, exists } from "jsr:@std/fs@1";

export interface DocEntry {
  slug: string;
  title: string;
  kind: string;
  desc: string;
  footLeft: string;
  footRight: string;
  src: string;
  visibility: "private" | "shared";
  review?: boolean;
}
export interface TopicEntry {
  num: string;
  id: string;
  name: string;
  short: string;
  docs: DocEntry[];
}

interface RawTopic {
  id: string;
  docs: Array<{ slug: string }>;
}

export function slugExists(registry: string, slug: string): boolean {
  const corpus = parseJsonc(registry) as unknown as RawTopic[];
  return corpus.some((t) => t.docs.some((d) => d.slug === slug));
}

function formatDoc(d: DocEntry, indent: string): string {
  const review = d.review ? `, "review": true` : "";
  return `${indent}{ "slug": ${JSON.stringify(d.slug)}, "title": ${JSON.stringify(d.title)},\n` +
    `${indent}  "kind": ${JSON.stringify(d.kind)}, "desc": ${JSON.stringify(d.desc)},\n` +
    `${indent}  "footLeft": ${JSON.stringify(d.footLeft)}, "footRight": ${
      JSON.stringify(d.footRight)
    },\n` +
    `${indent}  "src": ${JSON.stringify(d.src)}, "visibility": ${
      JSON.stringify(d.visibility)
    }${review} }`;
}

/** Index of the `]` that closes the array opened at `open`. */
function matchingClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** Insert a doc entry into an existing topic's `docs` array, preserving the
 * file's comments and formatting via targeted string surgery. */
export function insertDoc(registry: string, topicId: string, entry: DocEntry): string {
  if (slugExists(registry, entry.slug)) throw new Error(`duplicate slug: ${entry.slug}`);

  const topicAt = registry.search(new RegExp(`"id"\\s*:\\s*"${topicId}"`));
  if (topicAt === -1) throw new Error(`unknown topic: ${topicId}`);

  const docsKey = registry.indexOf('"docs"', topicAt);
  if (docsKey === -1) throw new Error(`topic ${topicId} has no docs array`);
  const open = registry.indexOf("[", docsKey);
  const close = matchingClose(registry, open);
  if (close === -1) throw new Error(`topic ${topicId} docs array is unterminated`);

  const inner = registry.slice(open + 1, close);
  const indentMatch = inner.match(/\n([ \t]+)\S/);
  const indent = indentMatch ? indentMatch[1] : "      ";
  const trimmed = inner.replace(/\s*$/, "");
  const sep = trimmed.trim().length ? ",\n" : "\n";
  const newInner = `${trimmed}${sep}${formatDoc(entry, indent)}\n${indent.slice(0, -2)}`;
  return registry.slice(0, open + 1) + newInner + registry.slice(close);
}

/** Append a new topic (with its docs) before the top-level closing `]`. */
export function insertTopic(registry: string, topic: TopicEntry): string {
  for (const d of topic.docs) {
    if (slugExists(registry, d.slug)) throw new Error(`duplicate slug: ${d.slug}`);
  }
  const lastClose = registry.lastIndexOf("]");
  if (lastClose === -1) throw new Error("registry is not a JSON array");
  const before = registry.slice(0, lastClose).replace(/\s*$/, "");
  const docs = topic.docs.map((d) => formatDoc(d, "      ")).join(",\n");
  const block =
    `,\n  {\n    "num": ${JSON.stringify(topic.num)}, "id": ${JSON.stringify(topic.id)},\n` +
    `    "name": ${JSON.stringify(topic.name)}, "short": ${JSON.stringify(topic.short)},\n` +
    `    "docs": [\n${docs}\n    ]\n  }\n`;
  return before + block + registry.slice(lastClose);
}

// --- CLI shell (only when run directly) ------------------------------------
if (import.meta.main) {
  const ROOT = dirname(fromFileUrl(import.meta.url));
  const REGISTRY_PATH = join(ROOT, "registry.jsonc");
  const MIGRATED = join(ROOT, "_migrated");
  const a = parseArgs(Deno.args, {
    string: [
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
  console.log(`Placed _migrated/${slug}.html ; run \`deno task serve\` to view.`);
}
