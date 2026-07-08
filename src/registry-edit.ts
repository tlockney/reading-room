/**
 * Reading Room — registry string surgery.
 *
 * Pure functions that edit registry.jsonc as TEXT, so the file's comments and
 * hand-formatting survive (a parse-and-reserialize round-trip would strip
 * them). Consumed by add-doc.ts (CLI registration) and serve.ts (the /api/
 * management routes).
 *
 * Scanning is string-literal-aware (brackets/braces inside quoted values are
 * skipped) but not comment-aware: a bracket inside a // comment placed inside
 * a docs array would confuse it. Registry comments live at the top of the
 * file, outside any array, so this stays out of harm's way. Likewise, a
 * commented-out entry carrying a live slug would be matched instead of the
 * real one.
 */
import { parse as parseJsonc } from "jsr:@std/jsonc@1";

/** One document entry as written into a topic's `docs` array. */
export interface DocEntry {
  /** Unique identifier across the whole registry; also the served URL path segment. */
  slug: string;
  /** Display title shown on the index card and doc page. */
  title: string;
  /** Document kind label (e.g. "Field Notes", "Reference") shown as the card eyebrow. */
  kind: string;
  /** One-sentence description shown on the index card. */
  desc: string;
  /** Left-hand footer line stamped onto the rendered doc. */
  footLeft: string;
  /** Right-hand footer line stamped onto the rendered doc. */
  footRight: string;
  /** Source HTML path, resolved relative to the workspace (dirname of the content root). */
  src: string;
  /** Publish scope: only "shared" docs make it into the published subset. */
  visibility: "private" | "shared";
  /** Review-quarantine flag; absent and false render identically. */
  review?: boolean;
}
/** One top-level topic in registry.jsonc, grouping an ordered list of docs. */
export interface TopicEntry {
  /** Display ordinal (e.g. "01") shown next to the topic name. */
  num: string;
  /** Stable topic identifier used by insertDoc and the management API. */
  id: string;
  /** Full topic name shown as the section heading. */
  name: string;
  /** Short topic label used where the full name won't fit. */
  short: string;
  /** The topic's documents, in display order. */
  docs: DocEntry[];
}

/** Patch for setDocField. review:false REMOVES the key (absent and false
 * render identically); visibility is always written explicitly. */
export interface DocPatch {
  /** New review state; false REMOVES the key rather than writing `"review": false`. */
  review?: boolean;
  /** New publish scope; always written explicitly (never removed). */
  visibility?: "private" | "shared";
}

/** Thrown when an edit names a slug that no doc entry in the registry carries. */
export class UnknownSlugError extends Error {
  /** Message is passed through to Error; the name is set to "UnknownSlugError". */
  constructor(message: string) {
    super(message);
    this.name = "UnknownSlugError";
  }
}

interface RawTopic {
  id: string;
  docs: Array<{ slug: string }>;
}

/** Whether any doc entry in the registry text carries `slug` (parsed, not string-matched). */
export function slugExists(registry: string, slug: string): boolean {
  const corpus = parseJsonc(registry) as unknown as RawTopic[];
  return corpus.some((t) => t.docs.some((d) => d.slug === slug));
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Index of the closer matching the opener at `open`, skipping string
 * literals (a `]` or `}` inside a quoted value must not count). */
function matchingClose(text: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === openCh) depth++;
    else if (c === closeCh && --depth === 0) return i;
  }
  return -1;
}

/** Bounds of the `{ ... }` entry carrying `"slug": "<slug>"`. Relies on
 * `slug` being the entry's first key — which formatDoc guarantees and the
 * hand-written registry follows. */
function docEntryRange(registry: string, slug: string): { open: number; close: number } {
  const slugAt = registry.search(new RegExp(`"slug"\\s*:\\s*"${reEscape(slug)}"`));
  if (slugAt === -1) throw new UnknownSlugError(`unknown slug: ${slug}`);
  const open = registry.lastIndexOf("{", slugAt);
  if (open === -1) throw new Error(`malformed registry near slug: ${slug}`);
  const close = matchingClose(registry, open, "{", "}");
  if (close === -1) throw new Error(`unterminated doc entry: ${slug}`);
  return { open, close };
}

/** Insert `, <field>` just before the entry's closing `}`. */
function insertBeforeClose(entry: string, field: string): string {
  const close = entry.lastIndexOf("}");
  const body = entry.slice(0, close).replace(/\s*$/, "");
  return `${body}, ${field} ${entry.slice(close)}`;
}

/** Set or clear `review` / `visibility` on one doc entry, leaving the rest of
 * the file byte-identical. */
export function setDocField(registry: string, slug: string, patch: DocPatch): string {
  const { open, close } = docEntryRange(registry, slug);
  let entry = registry.slice(open, close + 1);

  if (patch.visibility !== undefined) {
    const re = /("visibility"\s*:\s*)"(?:private|shared)"/;
    entry = re.test(entry)
      ? entry.replace(re, `$1"${patch.visibility}"`)
      : insertBeforeClose(entry, `"visibility": "${patch.visibility}"`);
  }
  if (patch.review !== undefined) {
    entry = entry.replace(/,?\s*"review"\s*:\s*(?:true|false)/, "").replace(/\{\s*,\s*/, "{ ");
    if (patch.review) entry = insertBeforeClose(entry, `"review": true`);
  }
  return registry.slice(0, open) + entry + registry.slice(close + 1);
}

/** Remove one doc entry (and the comma joining it to its neighbor). The
 * enclosing topic stays, even when it ends up empty. */
export function removeDoc(registry: string, slug: string): string {
  const { open, close } = docEntryRange(registry, slug);
  let start = open;
  let end = close + 1;
  // absorb the entry's leading indentation, back through its line break
  while (start > 0 && (registry[start - 1] === " " || registry[start - 1] === "\t")) start--;
  if (start > 0 && registry[start - 1] === "\n") start--;
  // prefer eating a trailing comma (entry is not last) …
  const after = registry.slice(end).match(/^[ \t\r\n]*,/);
  if (after) {
    end += after[0].length;
  } else {
    // … otherwise eat the comma that precedes it (entry is last)
    const before = registry.slice(0, start).match(/,[ \t\r\n]*$/);
    if (before) start -= before[0].length;
  }
  return registry.slice(0, start) + registry.slice(end);
}

/** Insert a doc entry into an existing topic's `docs` array. */
export function insertDoc(registry: string, topicId: string, entry: DocEntry): string {
  if (slugExists(registry, entry.slug)) throw new Error(`duplicate slug: ${entry.slug}`);

  const topicAt = registry.search(new RegExp(`"id"\\s*:\\s*"${reEscape(topicId)}"`));
  if (topicAt === -1) throw new Error(`unknown topic: ${topicId}`);

  const docsKey = registry.indexOf('"docs"', topicAt);
  if (docsKey === -1) throw new Error(`topic ${topicId} has no docs array`);
  const open = registry.indexOf("[", docsKey);
  const close = matchingClose(registry, open, "[", "]");
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
  const isEmpty = (parseJsonc(registry) as unknown[]).length === 0;
  const before = registry.slice(0, lastClose).replace(/\s*$/, "");
  const docs = topic.docs.map((d) => formatDoc(d, "      ")).join(",\n");
  const lead = isEmpty ? "\n" : ",\n";
  const block =
    `${lead}  {\n    "num": ${JSON.stringify(topic.num)}, "id": ${JSON.stringify(topic.id)},\n` +
    `    "name": ${JSON.stringify(topic.name)}, "short": ${JSON.stringify(topic.short)},\n` +
    `    "docs": [\n${docs}\n    ]\n  }\n`;
  return before + block + registry.slice(lastClose);
}
