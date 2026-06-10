# Interactive Reading Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Reading Room manageable from the browser — review/visibility toggles,
non-destructive removal, anchored marginalia comments — plus a configurable static publish of the
`visibility:shared` subset, with zero management chrome in published output.

**Architecture:** The pure render core (`render.ts`) and static builder (`build.ts`) keep their
current render path. All interactivity is added in the dynamic server: `serve.ts` gains `/api/`
routes and a post-render `injectAdmin()` step that appends an admin bundle (`assets/admin/`) served
only by it. Registry mutations are pure string surgery (new `registry-edit.ts`, extracted from
`add-doc.ts`) so `registry.jsonc` comments/formatting survive. Comments live in sidecar JSON
(`comments/<slug>.json`); source HTML is never modified.

**Tech Stack:** Deno (no build step, jsr:@std only — all deps already in `deno.lock`), vanilla
ES-module browser JS, JSON sidecar files.

**Spec:** `_specs/2026-06-10-interactive-reading-room-design.md`

---

## File structure

| File                     | Status | Responsibility                                                                                                                                        |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry-edit.ts`       | create | Pure string surgery on registry text: `insertDoc`/`insertTopic` (moved from add-doc.ts), `setDocField`, `removeDoc`, `slugExists`, `UnknownSlugError` |
| `registry-edit_test.ts`  | create | Surgery tests (comment preservation, first/middle/last/only removal, idempotency)                                                                     |
| `add-doc.ts`             | modify | Keep CLI; import + re-export surgery functions from `registry-edit.ts`                                                                                |
| `comments.ts`            | create | Sidecar comment store (load/add/delete, input validation, `writeAtomic`)                                                                              |
| `comments_test.ts`       | create | Store CRUD + validation tests                                                                                                                         |
| `assets/admin/anchor.js` | create | Pure text-quote anchoring (JSDoc-typed JS; imported by browser AND Deno tests)                                                                        |
| `anchor_test.ts`         | create | Anchor resolution preference order + context capture                                                                                                  |
| `admin.ts`               | create | Server-only `injectAdmin(html, ctx)` — admin bundle + page-context payload                                                                            |
| `admin_test.ts`          | create | Injector output + no-admin-in-publish guard tests                                                                                                     |
| `serve.ts`               | modify | `makeHandler(opts)` (testable), `/api/` routes, admin asset serving, READONLY, `import.meta.main` startup                                             |
| `serve_test.ts`          | create | Handler-level API tests against a temp-dir fixture                                                                                                    |
| `render.ts`              | modify | `loadCorpus(path = REGISTRY)` — one-line parametrization only                                                                                         |
| `assets/admin/admin.css` | create | Admin layer styling (theme-variable driven)                                                                                                           |
| `assets/admin/admin.js`  | create | Browser admin layer: manage mode, breadcrumb cluster, marginalia                                                                                      |
| `build.ts`               | modify | Exported `build(opts)` + `filterShared`; CLI behavior unchanged                                                                                       |
| `build_test.ts`          | create | `filterShared` tests                                                                                                                                  |
| `publish.ts`             | create | Shared-subset build → configured command (`publish.jsonc`, `{out}` substitution)                                                                      |
| `publish_test.ts`        | create | `parsePublishConfig` + `resolveCmd` tests                                                                                                             |
| `deno.jsonc`             | modify | `publish` task; serve/test permission updates                                                                                                         |
| `.gitignore`             | modify | Ignore `.publish/`                                                                                                                                    |
| `README.md`              | modify | Document manage mode, annotations, publish                                                                                                            |

Do NOT touch: `registry.jsonc` (avoid conflicts with uncommitted user edits on main),
`assets/editorial/*`, `skill/`, `agent.sh`, `_migrated/*` (the three untracked HTML files copied
into this worktree stay untracked — never `git add` them).

Conventions: match repo style — `//`-comment headers explaining the file's role, `jsr:@std/*@1`
imports, 100-char fmt width, lowercase-prefix commit subjects ("serve: …"). Never use `any` (use
`unknown` + narrowing). Before each commit run `deno fmt <changed .ts files>` and `deno lint`.

---

### Task 1: `registry-edit.ts` — extract surgery, add `setDocField` / `removeDoc`

**Files:**

- Create: `registry-edit.ts`, `registry-edit_test.ts`
- Modify: `add-doc.ts` (imports + re-exports; delete moved code)

- [ ] **Step 1.0: Baseline — confirm the suite passes before touching anything**

Run: `deno task test` Expected: all existing tests PASS (render, partials, add-doc, drift). If not,
STOP and report.

- [ ] **Step 1.1: Write the failing tests**

Create `registry-edit_test.ts`:

```typescript
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { removeDoc, setDocField, UnknownSlugError } from "./registry-edit.ts";

// Three docs across two topics; header comment and hand-formatting must survive.
const REGISTRY = `// header comment — must survive
[
  {
    "num": "§ 01", "id": "tooling",
    "name": "Tooling", "short": "Tooling",
    "docs": [
      { "slug": "alpha", "title": "Alpha", "kind": "Guide", "desc": "first [tricky] {chars}",
        "footLeft": "L", "footRight": "R", "src": "a.html", "visibility": "private" },
      { "slug": "beta", "title": "Beta", "kind": "Guide", "desc": "second",
        "footLeft": "L", "footRight": "R", "src": "b.html", "visibility": "shared", "review": true }
    ]
  },
  {
    "num": "§ 02", "id": "loops",
    "name": "Loops", "short": "Loops",
    "docs": [
      { "slug": "gamma", "title": "Gamma", "kind": "Essay", "desc": "third",
        "footLeft": "L", "footRight": "R", "src": "g.html", "visibility": "private" }
    ]
  }
]
`;

interface ParsedTopic {
  id: string;
  docs: Array<{ slug: string; visibility?: string; review?: boolean }>;
}
const parsed = (s: string): ParsedTopic[] => parseJsonc(s) as unknown as ParsedTopic[];
const docOf = (s: string, slug: string) => {
  for (const t of parsed(s)) for (const d of t.docs) if (d.slug === slug) return d;
  throw new Error(`no ${slug}`);
};

Deno.test("setDocField turns review on", () => {
  const out = setDocField(REGISTRY, "alpha", { review: true });
  assertEquals(docOf(out, "alpha").review, true);
  assert(out.startsWith("// header comment — must survive"));
});

Deno.test("setDocField review:false removes the key entirely", () => {
  const out = setDocField(REGISTRY, "beta", { review: false });
  assertEquals("review" in docOf(out, "beta"), false);
  assertEquals(out.includes('"slug": "beta"'), true);
});

Deno.test("setDocField review round-trip restores the original text", () => {
  const on = setDocField(REGISTRY, "alpha", { review: true });
  const off = setDocField(on, "alpha", { review: false });
  assertEquals(off, REGISTRY);
});

Deno.test("setDocField replaces an existing visibility value", () => {
  const out = setDocField(REGISTRY, "alpha", { visibility: "shared" });
  assertEquals(docOf(out, "alpha").visibility, "shared");
  // other docs untouched
  assertEquals(docOf(out, "beta").visibility, "shared");
  assertEquals(docOf(out, "gamma").visibility, "private");
});

Deno.test("setDocField inserts visibility when the key is absent", () => {
  const noVis = REGISTRY.replace(`"src": "g.html", "visibility": "private"`, `"src": "g.html"`);
  const out = setDocField(noVis, "gamma", { visibility: "shared" });
  assertEquals(docOf(out, "gamma").visibility, "shared");
});

Deno.test("setDocField applies review and visibility together", () => {
  const out = setDocField(REGISTRY, "gamma", { review: true, visibility: "shared" });
  const d = docOf(out, "gamma");
  assertEquals(d.review, true);
  assertEquals(d.visibility, "shared");
});

Deno.test("setDocField leaves every other entry byte-identical", () => {
  const out = setDocField(REGISTRY, "beta", { visibility: "private" });
  // the alpha and gamma lines are untouched text
  assert(
    out.includes(
      `"slug": "alpha", "title": "Alpha", "kind": "Guide", "desc": "first [tricky] {chars}"`,
    ),
  );
  assert(out.includes(`"slug": "gamma", "title": "Gamma", "kind": "Essay", "desc": "third"`));
});

Deno.test("setDocField throws UnknownSlugError for a missing slug", () => {
  assertThrows(() => setDocField(REGISTRY, "nope", { review: true }), UnknownSlugError, "nope");
});

Deno.test("removeDoc removes a first (non-last) entry and stays valid jsonc", () => {
  const out = removeDoc(REGISTRY, "alpha");
  const t = parsed(out).find((x) => x.id === "tooling")!;
  assertEquals(t.docs.map((d) => d.slug), ["beta"]);
  assert(out.startsWith("// header comment — must survive"));
});

Deno.test("removeDoc removes a last entry (eats the preceding comma)", () => {
  const out = removeDoc(REGISTRY, "beta");
  const t = parsed(out).find((x) => x.id === "tooling")!;
  assertEquals(t.docs.map((d) => d.slug), ["alpha"]);
});

Deno.test("removeDoc removes the only doc, leaving an empty (valid) topic", () => {
  const out = removeDoc(REGISTRY, "gamma");
  const t = parsed(out).find((x) => x.id === "loops")!;
  assertEquals(t.docs, []);
});

Deno.test("removeDoc throws UnknownSlugError for a missing slug", () => {
  assertThrows(() => removeDoc(REGISTRY, "nope"), UnknownSlugError, "nope");
});

Deno.test("surgery tolerates brackets and braces inside string values", () => {
  // alpha's desc contains "[tricky] {chars}" — entry-range scanning must skip strings
  const out = removeDoc(REGISTRY, "alpha");
  assertEquals(parsed(out).find((x) => x.id === "tooling")!.docs.length, 1);
});
```

- [ ] **Step 1.2: Run the tests to verify they fail**

Run: `deno test --allow-read registry-edit_test.ts` Expected: FAIL —
`Module not found ... registry-edit.ts`

- [ ] **Step 1.3: Create `registry-edit.ts`**

Move the pure pieces out of `add-doc.ts` and add the new editors. Full file:

```typescript
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
 * file, outside any array, so this stays out of harm's way.
 */
import { parse as parseJsonc } from "jsr:@std/jsonc@1";

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

/** Patch for setDocField. review:false REMOVES the key (absent and false
 * render identically); visibility is always written explicitly. */
export interface DocPatch {
  review?: boolean;
  visibility?: "private" | "shared";
}

export class UnknownSlugError extends Error {}

interface RawTopic {
  id: string;
  docs: Array<{ slug: string }>;
}

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
  const before = registry.slice(0, lastClose).replace(/\s*$/, "");
  const docs = topic.docs.map((d) => formatDoc(d, "      ")).join(",\n");
  const block =
    `,\n  {\n    "num": ${JSON.stringify(topic.num)}, "id": ${JSON.stringify(topic.id)},\n` +
    `    "name": ${JSON.stringify(topic.name)}, "short": ${JSON.stringify(topic.short)},\n` +
    `    "docs": [\n${docs}\n    ]\n  }\n`;
  return before + block + registry.slice(lastClose);
}
```

Note: `matchingClose` gained string-awareness and explicit open/close chars vs. the add-doc.ts
original — `insertDoc`/`insertTopic` behavior is otherwise identical, and their existing tests pin
that.

- [ ] **Step 1.4: Slim `add-doc.ts` to CLI + re-exports**

Replace everything in `add-doc.ts` from the first `export interface DocEntry` line through the end
of `insertTopic` (i.e. everything between the imports and the `// --- CLI shell` comment) with
imports/re-exports, and drop the now-unused imports. The top of the file becomes:

```typescript
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
 * The pure registry editors live in registry-edit.ts (shared with serve.ts's
 * management API) and are re-exported here for back-compat.
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { basename, dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { copy, exists } from "jsr:@std/fs@1";
import { insertDoc, insertTopic } from "./registry-edit.ts";
import type { DocEntry } from "./registry-edit.ts";

export { insertDoc, insertTopic, slugExists } from "./registry-edit.ts";
export type { DocEntry, TopicEntry } from "./registry-edit.ts";
```

The `// --- CLI shell (only when run directly) ---` block stays exactly as it is.

- [ ] **Step 1.5: Run the full suite**

Run: `deno task test` Expected: ALL PASS — new registry-edit tests AND the existing
`add-doc_test.ts` (which still imports from `./add-doc.ts`).

- [ ] **Step 1.6: Format, lint, commit**

```bash
deno fmt registry-edit.ts registry-edit_test.ts add-doc.ts && deno lint
git add registry-edit.ts registry-edit_test.ts add-doc.ts
git commit -m "registry-edit: extract pure surgery; add setDocField/removeDoc"
```

---

### Task 2: `comments.ts` — sidecar comment store

**Files:**

- Create: `comments.ts`, `comments_test.ts`
- Modify: `deno.jsonc` (test task needs `--allow-write` for temp dirs)

- [ ] **Step 2.1: Update the test task permissions**

In `deno.jsonc`, change the test task line to:

```jsonc
// Run the test suite (render injection, registry surgery, comments, skill drift).
"test": "deno test --allow-read --allow-write --allow-env",
```

- [ ] **Step 2.2: Write the failing tests**

Create `comments_test.ts`:

```typescript
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { addComment, deleteComment, loadComments, parseCommentInput } from "./comments.ts";

const INPUT = {
  quote: "the loop is the expensive part",
  prefix: "punchline: ",
  suffix: ".",
  note: "verify this claim",
};

Deno.test("loadComments returns [] when no sidecar exists", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await loadComments(dir, "ghost"), []);
});

Deno.test("addComment assigns id/created and persists", async () => {
  const dir = await Deno.makeTempDir();
  const c = await addComment(dir, "alpha", INPUT);
  assert(c.id.length > 0);
  assert(!Number.isNaN(Date.parse(c.created)));
  const all = await loadComments(dir, "alpha");
  assertEquals(all.length, 1);
  assertEquals(all[0].note, "verify this claim");
  // sidecar file is per-slug
  assert((await Deno.stat(join(dir, "alpha.json"))).isFile);
});

Deno.test("comments accumulate per slug, isolated across slugs", async () => {
  const dir = await Deno.makeTempDir();
  await addComment(dir, "alpha", INPUT);
  await addComment(dir, "alpha", { ...INPUT, note: "second" });
  await addComment(dir, "beta", { ...INPUT, note: "other doc" });
  assertEquals((await loadComments(dir, "alpha")).length, 2);
  assertEquals((await loadComments(dir, "beta")).length, 1);
});

Deno.test("deleteComment removes by id; false for unknown id", async () => {
  const dir = await Deno.makeTempDir();
  const c = await addComment(dir, "alpha", INPUT);
  assertEquals(await deleteComment(dir, "alpha", c.id), true);
  assertEquals(await loadComments(dir, "alpha"), []);
  assertEquals(await deleteComment(dir, "alpha", c.id), false);
});

Deno.test("parseCommentInput accepts a valid body", () => {
  assertEquals(parseCommentInput(INPUT), INPUT);
});

Deno.test("parseCommentInput rejects bad shapes with a reason", () => {
  assertEquals(typeof parseCommentInput(null), "string");
  assertEquals(typeof parseCommentInput("hi"), "string");
  assertEquals(typeof parseCommentInput({ ...INPUT, note: 7 }), "string");
  assertEquals(typeof parseCommentInput({ ...INPUT, note: "  " }), "string");
  assertEquals(typeof parseCommentInput({ ...INPUT, quote: "" }), "string");
  assertEquals(typeof parseCommentInput({ prefix: "", suffix: "", note: "n" }), "string"); // quote missing
  assertEquals(typeof parseCommentInput({ ...INPUT, note: "x".repeat(10_001) }), "string");
});
```

- [ ] **Step 2.3: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write comments_test.ts` Expected: FAIL —
`Module not found ... comments.ts`

- [ ] **Step 2.4: Create `comments.ts`**

```typescript
/**
 * Reading Room — sidecar comment store.
 *
 * One JSON file per doc at <dir>/<slug>.json (the live server uses
 * comments/<slug>.json). Source documents are never touched, and the static
 * build has no comment path at all — annotations are local review apparatus.
 *
 * Anchoring fields (quote/prefix/suffix) follow W3C-annotation text quoting;
 * resolution happens client-side (assets/admin/anchor.js).
 */
import { ensureDir } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";

export interface Comment {
  id: string;
  created: string; // ISO-8601
  quote: string; // exact selected text
  prefix: string; // up to ~32 chars before the selection
  suffix: string; // up to ~32 chars after
  note: string; // the annotation body
}

export type CommentInput = Pick<Comment, "quote" | "prefix" | "suffix" | "note">;

const MAX = { quote: 2000, prefix: 64, suffix: 64, note: 10_000 } as const;

/** Validate an unknown request body into a CommentInput, or explain why not. */
export function parseCommentInput(raw: unknown): CommentInput | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const o = raw as Record<string, unknown>;
  for (const k of ["quote", "prefix", "suffix", "note"] as const) {
    const v = o[k];
    if (typeof v !== "string") return `${k} must be a string`;
    if (v.length > MAX[k]) return `${k} exceeds ${MAX[k]} chars`;
  }
  const quote = o.quote as string;
  const note = o.note as string;
  if (quote.trim() === "") return "quote must be non-empty";
  if (note.trim() === "") return "note must be non-empty";
  return { quote, prefix: o.prefix as string, suffix: o.suffix as string, note };
}

/** Write via temp file + rename so a crash can't leave a torn file. Shared
 * with serve.ts, which uses it for registry.jsonc as well. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
}

const fileFor = (dir: string, slug: string): string => join(dir, `${slug}.json`);

export async function loadComments(dir: string, slug: string): Promise<Comment[]> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(fileFor(dir, slug)));
    return Array.isArray(parsed) ? parsed as Comment[] : [];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

export async function addComment(dir: string, slug: string, input: CommentInput): Promise<Comment> {
  await ensureDir(dir);
  const all = await loadComments(dir, slug);
  const comment: Comment = { id: crypto.randomUUID(), created: new Date().toISOString(), ...input };
  all.push(comment);
  await writeAtomic(fileFor(dir, slug), JSON.stringify(all, null, 2) + "\n");
  return comment;
}

export async function deleteComment(dir: string, slug: string, id: string): Promise<boolean> {
  const all = await loadComments(dir, slug);
  const keep = all.filter((c) => c.id !== id);
  if (keep.length === all.length) return false;
  await writeAtomic(fileFor(dir, slug), JSON.stringify(keep, null, 2) + "\n");
  return true;
}
```

- [ ] **Step 2.5: Run the full suite**

Run: `deno task test` Expected: ALL PASS.

- [ ] **Step 2.6: Format, lint, commit**

```bash
deno fmt comments.ts comments_test.ts && deno lint
git add comments.ts comments_test.ts deno.jsonc
git commit -m "comments: sidecar store with text-quote anchoring fields"
```

---

### Task 3: `assets/admin/anchor.js` — pure anchoring

**Files:**

- Create: `assets/admin/anchor.js`, `anchor_test.ts`

This is plain JS with JSDoc types because the SAME file is imported by the browser (`admin.js`) and
by the Deno test — no duplication, no drift.

- [ ] **Step 3.1: Write the failing tests**

Create `anchor_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert@1";
import { describeRange, findAnchor } from "./assets/admin/anchor.js";

const TEXT =
  "The loop is the expensive part. The loop is also the fun part. End of the loop story.";

Deno.test("findAnchor prefers prefix+quote+suffix", () => {
  // "The loop is" appears twice; context picks the second
  const hit = findAnchor(TEXT, { prefix: "part. ", quote: "The loop is", suffix: " also" });
  assertEquals(hit, { start: 32, end: 43 });
});

Deno.test("findAnchor falls back to prefix+quote", () => {
  const hit = findAnchor(TEXT, { prefix: "part. ", quote: "The loop is", suffix: "ZZZ" });
  assertEquals(hit, { start: 32, end: 43 });
});

Deno.test("findAnchor falls back to quote+suffix", () => {
  const hit = findAnchor(TEXT, { prefix: "ZZZ", quote: "The loop is", suffix: " also" });
  assertEquals(hit, { start: 32, end: 43 });
});

Deno.test("findAnchor falls back to first bare quote", () => {
  const hit = findAnchor(TEXT, { prefix: "ZZZ", quote: "The loop is", suffix: "ZZZ" });
  assertEquals(hit, { start: 0, end: 11 });
});

Deno.test("findAnchor returns null when the quote is gone", () => {
  assertEquals(findAnchor(TEXT, { prefix: "", quote: "vanished text", suffix: "" }), null);
  assertEquals(findAnchor(TEXT, { prefix: "", quote: "", suffix: "" }), null);
});

Deno.test("describeRange captures quote plus bounded context", () => {
  const d = describeRange(TEXT, 32, 43, 6);
  assertEquals(d, { quote: "The loop is", prefix: "part. ", suffix: " also " });
});

Deno.test("describeRange clamps context at the text edges", () => {
  const d = describeRange(TEXT, 0, 3, 32);
  assertEquals(d.prefix, "");
  assertEquals(d.quote, "The");
});

Deno.test("describeRange → findAnchor round-trips", () => {
  const d = describeRange(TEXT, 32, 43);
  assertEquals(findAnchor(TEXT, d), { start: 32, end: 43 });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `deno test --allow-read anchor_test.ts` Expected: FAIL — module not found.

- [ ] **Step 3.3: Create `assets/admin/anchor.js`**

```javascript
/**
 * Reading Room — text-quote anchoring (W3C-annotation style). Pure, no DOM.
 *
 * Shared verbatim by the browser admin layer (assets/admin/admin.js imports
 * it as an ES module) and the Deno test suite (anchor_test.ts) — one file,
 * no drift. JSDoc types keep it honest under Deno's checker.
 */

/**
 * Locate `quote` inside `text`. Preference order:
 *  1. prefix + quote + suffix   2. prefix + quote
 *  3. quote + suffix            4. first bare quote
 * @param {string} text
 * @param {{prefix?: string, quote: string, suffix?: string}} sel
 * @returns {{start: number, end: number} | null}
 */
export function findAnchor(text, { prefix = "", quote, suffix = "" }) {
  if (!quote) return null;
  const tries = [
    [prefix + quote + suffix, prefix.length],
    [prefix + quote, prefix.length],
    [quote + suffix, 0],
    [quote, 0],
  ];
  for (const [needle, offset] of tries) {
    const at = text.indexOf(/** @type {string} */ (needle));
    if (at !== -1) {
      const start = at + /** @type {number} */ (offset);
      return { start, end: start + quote.length };
    }
  }
  return null;
}

/**
 * Describe a [start,end) selection as quote + surrounding context.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {number} [ctx=32] context chars captured on each side
 * @returns {{quote: string, prefix: string, suffix: string}}
 */
export function describeRange(text, start, end, ctx = 32) {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ctx), start),
    suffix: text.slice(end, end + ctx),
  };
}
```

- [ ] **Step 3.4: Run the full suite**

Run: `deno task test` Expected: ALL PASS.

- [ ] **Step 3.5: Format, lint, commit**

```bash
deno fmt assets/admin/anchor.js anchor_test.ts && deno lint
git add assets/admin/anchor.js anchor_test.ts
git commit -m "admin: pure text-quote anchor resolution, shared browser/test"
```

---

### Task 4: `serve.ts` — testable handler + management API

**Files:**

- Modify: `serve.ts` (full rework below), `render.ts` (one line), `deno.jsonc` (serve task perms)
- Create: `serve_test.ts`

- [ ] **Step 4.1: Parametrize `loadCorpus` in `render.ts`**

Change (only this — nothing else in render.ts):

```typescript
export async function loadCorpus(path: string = REGISTRY): Promise<Topic[]> {
  return parseJsonc(await Deno.readTextFile(path)) as unknown as Topic[];
}
```

- [ ] **Step 4.2: Write the failing handler tests**

Create `serve_test.ts`. Note the fixture registry needs no source HTML files — the API routes and
the index render never read doc sources.

```typescript
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { join } from "jsr:@std/path@1";
import { makeHandler } from "./serve.ts";

const FIXTURE = `// fixture registry
[
  {
    "num": "§ 01", "id": "tooling",
    "name": "Tooling", "short": "Tooling",
    "docs": [
      { "slug": "alpha", "title": "Alpha", "kind": "Guide", "desc": "first",
        "footLeft": "L", "footRight": "R", "src": "a.html", "visibility": "private" },
      { "slug": "beta", "title": "Beta", "kind": "Guide", "desc": "second",
        "footLeft": "L", "footRight": "R", "src": "b.html", "visibility": "shared", "review": true }
    ]
  }
]
`;

async function fixture(readonly = false) {
  const dir = await Deno.makeTempDir();
  const registryPath = join(dir, "registry.jsonc");
  await Deno.writeTextFile(registryPath, FIXTURE);
  const commentsDir = join(dir, "comments");
  return {
    registryPath,
    commentsDir,
    handler: makeHandler({ registryPath, commentsDir, readonly }),
  };
}

const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const jsonReq = (path: string, method: string, body: unknown) =>
  req(path, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

Deno.test("PATCH review:true updates the registry text", async () => {
  const f = await fixture();
  const res = await f.handler(jsonReq("/api/docs/alpha", "PATCH", { review: true }));
  assertEquals(res.status, 200);
  const text = await Deno.readTextFile(f.registryPath);
  assert(text.includes(`"review": true`));
  assert(text.startsWith("// fixture registry")); // comments survive
});

Deno.test("PATCH visibility flips the field", async () => {
  const f = await fixture();
  const res = await f.handler(jsonReq("/api/docs/alpha", "PATCH", { visibility: "shared" }));
  assertEquals(res.status, 200);
  interface T {
    docs: Array<{ slug: string; visibility: string }>;
  }
  const corpus = parseJsonc(await Deno.readTextFile(f.registryPath)) as unknown as T[];
  assertEquals(corpus[0].docs.find((d) => d.slug === "alpha")!.visibility, "shared");
});

Deno.test("PATCH unknown slug → 404; bad bodies → 400", async () => {
  const f = await fixture();
  assertEquals((await f.handler(jsonReq("/api/docs/nope", "PATCH", { review: true }))).status, 404);
  assertEquals(
    (await f.handler(jsonReq("/api/docs/alpha", "PATCH", { review: "yes" }))).status,
    400,
  );
  assertEquals((await f.handler(jsonReq("/api/docs/alpha", "PATCH", { bogus: 1 }))).status, 400);
  assertEquals((await f.handler(jsonReq("/api/docs/alpha", "PATCH", {}))).status, 400);
  assertEquals(
    (await f.handler(req("/api/docs/alpha", { method: "PATCH", body: "not json" }))).status,
    400,
  );
});

Deno.test("DELETE deregisters; registry stays valid jsonc", async () => {
  const f = await fixture();
  const res = await f.handler(req("/api/docs/alpha", { method: "DELETE" }));
  assertEquals(res.status, 200);
  const body = await res.json() as { note: string };
  assert(body.note.includes("_migrated"));
  interface T {
    docs: Array<{ slug: string }>;
  }
  const corpus = parseJsonc(await Deno.readTextFile(f.registryPath)) as unknown as T[];
  assertEquals(corpus[0].docs.map((d) => d.slug), ["beta"]);
});

Deno.test("comments: POST → GET → DELETE round-trip", async () => {
  const f = await fixture();
  const input = { quote: "q", prefix: "p", suffix: "s", note: "check this" };
  const post = await f.handler(jsonReq("/api/docs/alpha/comments", "POST", input));
  assertEquals(post.status, 201);
  const created = await post.json() as { id: string };

  const get = await f.handler(req("/api/docs/alpha/comments"));
  assertEquals(get.status, 200);
  const list = await get.json() as Array<{ id: string; note: string }>;
  assertEquals(list.length, 1);
  assertEquals(list[0].note, "check this");

  const del = await f.handler(req(`/api/docs/alpha/comments/${created.id}`, { method: "DELETE" }));
  assertEquals(del.status, 200);
  assertEquals(
    (await f.handler(req(`/api/docs/alpha/comments/${created.id}`, { method: "DELETE" }))).status,
    404,
  );
});

Deno.test("comments: POST to an unregistered slug → 404; bad input → 400", async () => {
  const f = await fixture();
  const input = { quote: "q", prefix: "", suffix: "", note: "n" };
  assertEquals((await f.handler(jsonReq("/api/docs/ghost/comments", "POST", input))).status, 404);
  assertEquals(
    (await f.handler(jsonReq("/api/docs/alpha/comments", "POST", { note: "no quote" }))).status,
    400,
  );
});

Deno.test("READONLY blocks mutations but not reads", async () => {
  const f = await fixture(true);
  assertEquals(
    (await f.handler(jsonReq("/api/docs/alpha", "PATCH", { review: true }))).status,
    403,
  );
  assertEquals((await f.handler(req("/api/docs/alpha", { method: "DELETE" }))).status, 403);
  assertEquals(
    (await f.handler(
      jsonReq("/api/docs/alpha/comments", "POST", {
        quote: "q",
        prefix: "",
        suffix: "",
        note: "n",
      }),
    )).status,
    403,
  );
  assertEquals((await f.handler(req("/api/docs/alpha/comments"))).status, 200);
});

Deno.test("unknown api path → 404 JSON; wrong method → 405", async () => {
  const f = await fixture();
  assertEquals((await f.handler(req("/api/whatever"))).status, 404);
  assertEquals((await f.handler(req("/api/docs/alpha", { method: "PUT" }))).status, 405);
});

Deno.test("GET / renders the index from the configured registry", async () => {
  const f = await fixture();
  const res = await f.handler(req("/"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assert(html.includes("Alpha"));
  assert(html.includes("For Review")); // beta carries review: true
});
```

- [ ] **Step 4.3: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env serve_test.ts` Expected: FAIL — `makeHandler`
is not exported (and serve.ts starts a server on import — the rework removes that).

- [ ] **Step 4.4: Rework `serve.ts`**

Replace the whole file (the admin injection import/call lands in Task 5 — note the `TODO(admin)`
markers are _placeholders for Task 5, not for the engineer to skip_; Task 5 removes them):

```typescript
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env=PORT,READONLY
/**
 * Serve the Reading Room locally — rendered DYNAMICALLY per request, no build
 * step. Binds 127.0.0.1 ONLY; expose it over your tailnet (HTTPS, tailnet-only)
 * with `tailscale serve`. Editing registry.jsonc or any source doc shows up on
 * the next refresh; new documents appear without restarting.
 *
 * This server is also the ONLY place management lives: the /api/ routes
 * (review / visibility / remove / comments) and the injected admin layer
 * exist solely here. build.ts shares the render path but never the admin
 * layer, so published static output stays clean. Set READONLY=1 to expose a
 * view-only instance (mutation routes return 403).
 *
 *   deno task serve            # 127.0.0.1:8413
 *   PORT=9000 deno task serve  # or:  deno task serve 9000
 *
 * (Run under launchd via ./agent.sh install for an always-on local agent.)
 */
import { loadCorpus, REGISTRY, renderIndex, ROOT, transformDoc } from "./render.ts";
import type { Doc, Topic } from "./render.ts";
import { removeDoc, setDocField, slugExists, UnknownSlugError } from "./registry-edit.ts";
import type { DocPatch } from "./registry-edit.ts";
import {
  addComment,
  deleteComment,
  loadComments,
  parseCommentInput,
  writeAtomic,
} from "./comments.ts";
import { join } from "jsr:@std/path@1";

const DOC_RE = /^\/docs\/([A-Za-z0-9_-]+)\/?$/; // canonical: /docs/<slug> (S3 also serves /docs/<slug>/)
const DOC_HTML_RE = /^\/docs\/([A-Za-z0-9._-]+)\.html$/; // legacy: redirect to extensionless
const API_DOC_RE = /^\/api\/docs\/([A-Za-z0-9_-]+)$/;
const API_COMMENTS_RE = /^\/api\/docs\/([A-Za-z0-9_-]+)\/comments$/;
const API_COMMENT_RE = /^\/api\/docs\/([A-Za-z0-9_-]+)\/comments\/([A-Za-z0-9-]+)$/;

export interface ServeOptions {
  registryPath: string;
  commentsDir: string;
  readonly: boolean;
}

function page(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function notice(msg: string, status: number): Response {
  return page(`<p style="font-family:monospace;padding:28px;color:#a85a1a">${msg}</p>`, status);
}
function redirect(location: string): Response {
  return new Response(null, { status: 301, headers: { location } });
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}
async function asset(name: string, type: string): Promise<Response> {
  try {
    return new Response(await Deno.readFile(join(ROOT, name)), {
      headers: { "content-type": type, "cache-control": "max-age=3600" },
    });
  } catch {
    return notice("Not found.", 404);
  }
}

function findDoc(corpus: Topic[], slug: string): { topic: Topic; doc: Doc } | null {
  for (const topic of corpus) {
    for (const doc of topic.docs) if (doc.slug === slug) return { topic, doc };
  }
  return null;
}

// --- /api/ ------------------------------------------------------------------

/** Narrow an unknown PATCH body to a DocPatch, or explain why not. */
function parsePatch(raw: unknown): DocPatch | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const o = raw as Record<string, unknown>;
  const patch: DocPatch = {};
  for (const key of Object.keys(o)) {
    if (key === "review") {
      if (typeof o.review !== "boolean") return "review must be a boolean";
      patch.review = o.review;
    } else if (key === "visibility") {
      if (o.visibility !== "private" && o.visibility !== "shared") {
        return 'visibility must be "private" or "shared"';
      }
      patch.visibility = o.visibility;
    } else {
      return `unknown field: ${key}`;
    }
  }
  if (patch.review === undefined && patch.visibility === undefined) return "nothing to change";
  return patch;
}

async function readJson(req: Request): Promise<unknown | symbol> {
  try {
    return await req.json();
  } catch {
    return NOT_JSON;
  }
}
const NOT_JSON = Symbol("not json");

async function api(req: Request, path: string, opts: ServeOptions): Promise<Response> {
  if (opts.readonly && req.method !== "GET") return jsonError("read-only mode", 403);
  try {
    const doc = path.match(API_DOC_RE);
    if (doc) {
      const slug = doc[1];
      if (req.method === "PATCH") {
        const raw = await readJson(req);
        if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
        const patch = parsePatch(raw);
        if (typeof patch === "string") return jsonError(patch, 400);
        const registry = await Deno.readTextFile(opts.registryPath);
        await writeAtomic(opts.registryPath, setDocField(registry, slug, patch));
        return json({ ok: true, slug, ...patch });
      }
      if (req.method === "DELETE") {
        const registry = await Deno.readTextFile(opts.registryPath);
        await writeAtomic(opts.registryPath, removeDoc(registry, slug));
        return json({
          ok: true,
          removed: slug,
          note: "registry entry removed; the _migrated copy (if any) is left on disk",
        });
      }
      return jsonError("method not allowed", 405);
    }

    const comments = path.match(API_COMMENTS_RE);
    if (comments) {
      const slug = comments[1];
      if (req.method === "GET") return json(await loadComments(opts.commentsDir, slug));
      if (req.method === "POST") {
        const registry = await Deno.readTextFile(opts.registryPath);
        if (!slugExists(registry, slug)) return jsonError(`unknown slug: ${slug}`, 404);
        const raw = await readJson(req);
        if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
        const input = parseCommentInput(raw);
        if (typeof input === "string") return jsonError(input, 400);
        return json(await addComment(opts.commentsDir, slug, input), 201);
      }
      return jsonError("method not allowed", 405);
    }

    const comment = path.match(API_COMMENT_RE);
    if (comment && req.method === "DELETE") {
      const ok = await deleteComment(opts.commentsDir, comment[1], comment[2]);
      return ok ? json({ ok: true }) : jsonError("no such comment", 404);
    }

    return jsonError("not found", 404);
  } catch (err) {
    if (err instanceof UnknownSlugError) return jsonError(err.message, 404);
    return jsonError(String(err), 500);
  }
}

// --- handler ------------------------------------------------------------------

export function makeHandler(opts: ServeOptions): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/favicon.svg") return asset("favicon.svg", "image/svg+xml");
    if (path === "/apple-touch-icon.png") return asset("apple-touch-icon.png", "image/png");
    if (path === "/index.html") return redirect("/");
    const legacy = path.match(DOC_HTML_RE);
    if (legacy) return redirect(`/docs/${legacy[1]}`);
    if (path.startsWith("/api/")) return api(req, path, opts);
    try {
      const corpus = await loadCorpus(opts.registryPath); // re-read per request → no restart needed
      if (path === "/") {
        return page(renderIndex(corpus)); // TODO(admin): injectAdmin in Task 5
      }
      const m = path.match(DOC_RE);
      if (m) {
        const found = findDoc(corpus, m[1]);
        if (!found) return notice(`No such document: <b>${esc(m[1])}</b>`, 404);
        const html = await transformDoc(corpus, found.topic, found.doc);
        return page(html); // TODO(admin): injectAdmin in Task 5
      }
      return notice("Not found.", 404);
    } catch (err) {
      return notice(`Render error:<br><br>${esc(String(err))}`, 500);
    }
  };
}

// --- startup (only when run directly) ----------------------------------------

if (import.meta.main) {
  const port = Number(Deno.args[0] ?? Deno.env.get("PORT") ?? 8413);
  const readonly = Deno.env.get("READONLY") === "1";
  const handler = makeHandler({
    registryPath: REGISTRY,
    commentsDir: join(ROOT, "comments"),
    readonly,
  });

  console.log(`\n  Reading Room — rendered live on http://127.0.0.1:${port}/ (localhost only).`);
  console.log(`  Expose over your tailnet (HTTPS):  tailscale serve --bg ${port}`);
  if (readonly) console.log("  READONLY=1 — management routes disabled (view-only).");
  console.log(
    "  Edits to registry.jsonc / source docs show on refresh — no restart. Ctrl-C to stop.\n",
  );

  // Watch the registry for console feedback; freshness comes from the per-request re-read.
  (async () => {
    try {
      for await (const ev of Deno.watchFs(REGISTRY)) {
        if (ev.kind === "modify" || ev.kind === "create") {
          console.log("  ↻ registry.jsonc changed — reflected on next request");
        }
      }
    } catch { /* watch unavailable */ }
  })();

  Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, handler);
}
```

- [ ] **Step 4.5: Update the serve task permissions in `deno.jsonc`**

```jsonc
// Serve locally on 127.0.0.1 (expose via `tailscale serve`). PORT env or
// first CLI arg overrides the default 8413. READONLY=1 disables the
// management API (view-only). Needs write access for registry/comments.
"serve": "deno run --allow-read --allow-write --allow-net --allow-env=PORT,READONLY serve.ts",
```

- [ ] **Step 4.6: Run the full suite**

Run: `deno task test` Expected: ALL PASS.

- [ ] **Step 4.7: Smoke-run the server**

```bash
deno task serve 8499 &   # background
sleep 1
curl -s http://127.0.0.1:8499/ | grep -c "Reading"        # expect ≥ 1
curl -s -X PATCH http://127.0.0.1:8499/api/docs/about-this-library \
  -H 'content-type: application/json' -d '{"review": true}'   # expect {"ok":true,...}
curl -s http://127.0.0.1:8499/ | grep -c "For Review"      # expect ≥ 1
curl -s -X PATCH http://127.0.0.1:8499/api/docs/about-this-library \
  -H 'content-type: application/json' -d '{"review": false}'  # put it back
git diff --exit-code registry.jsonc                         # expect NO diff (round-trip exact)
kill %1
```

- [ ] **Step 4.8: Format, lint, commit**

```bash
deno fmt serve.ts serve_test.ts render.ts && deno lint
git add serve.ts serve_test.ts render.ts deno.jsonc
git commit -m "serve: management api (review/visibility/remove/comments), testable handler"
```

---

### Task 5: `admin.ts` injector + admin asset route + guard tests

**Files:**

- Create: `admin.ts`, `admin_test.ts`
- Modify: `serve.ts` (wire `injectAdmin` + serve `/assets/admin/*`)

- [ ] **Step 5.1: Write the failing tests**

Create `admin_test.ts`:

```typescript
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { type AdminContext, injectAdmin } from "./admin.ts";
import { loadCorpus, renderIndex } from "./render.ts";

const ROOT = dirname(fromFileUrl(import.meta.url));
const MINIMAL = `<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>`;

const CTX: AdminContext = {
  page: "doc",
  readonly: false,
  doc: { slug: "alpha", review: true, visibility: "private" },
};

Deno.test("injectAdmin appends the bundle before </body> with markers", () => {
  const out = injectAdmin(MINIMAL, CTX);
  assert(out.includes("<!-- RR-ADMIN:start -->"));
  assert(out.includes("<!-- RR-ADMIN:end -->"));
  assert(out.indexOf("RR-ADMIN:start") < out.indexOf("</body>"));
  assert(out.includes(`src="/assets/admin/admin.js"`));
  assert(out.includes(`href="/assets/admin/admin.css"`));
});

Deno.test("injectAdmin embeds the context as parseable JSON", () => {
  const out = injectAdmin(MINIMAL, CTX);
  const m = out.match(/window\.__RR = (.*?);<\/script>/);
  assert(m, "context payload missing");
  const parsed = JSON.parse(m![1]) as AdminContext;
  assertEquals(parsed, CTX);
});

Deno.test("script payload cannot break out of its <script> tag", () => {
  // a hostile slug is impossible via the API (route regex), but pin the escape anyway
  const ctx: AdminContext = {
    page: "doc",
    readonly: false,
    doc: { slug: "</script><script>alert(1)", review: false, visibility: "private" },
  };
  const out = injectAdmin(MINIMAL, ctx);
  assertEquals(out.includes("</script><script>alert(1)"), false);
});

// --- the publish-purity guards ----------------------------------------------

Deno.test("static render path carries no admin layer", async () => {
  const corpus = await loadCorpus();
  assertEquals(renderIndex(corpus).includes("RR-ADMIN"), false);
});

Deno.test("build.ts and render.ts never touch the admin injector or comments", async () => {
  for (const name of ["build.ts", "render.ts"]) {
    const src = await Deno.readTextFile(join(ROOT, name));
    assertEquals(src.includes("admin.ts"), false, `${name} must not import admin.ts`);
    assertEquals(src.includes("comments.ts"), false, `${name} must not import comments.ts`);
  }
});

Deno.test("the standalone skill template carries no admin layer", async () => {
  const tpl = await Deno.readTextFile(
    join(ROOT, "skill/editorial-longform-html/assets/engineering-reference.html"),
  );
  assertEquals(tpl.includes("RR-ADMIN"), false);
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env admin_test.ts` Expected: FAIL — module
`admin.ts` not found.

- [ ] **Step 5.3: Create `admin.ts`**

```typescript
/**
 * Reading Room — server-only admin layer injection.
 *
 * Appends the management bundle (assets/admin/) plus a page-context payload
 * to pages served by serve.ts. build.ts MUST NOT import this module — that is
 * what keeps published static output free of management chrome, and
 * admin_test.ts pins it.
 */
const ADMIN_START = "<!-- RR-ADMIN:start -->";
const ADMIN_END = "<!-- RR-ADMIN:end -->";

export interface DocState {
  slug: string;
  review: boolean;
  visibility: string;
}
export type AdminContext =
  | { page: "index"; readonly: boolean; docs: Record<string, Omit<DocState, "slug">> }
  | { page: "doc"; readonly: boolean; doc: DocState };

const BODY_END_RE = /<\/body>/i;

/** Serialize for a <script> body: <-escape so "</script>" can't break out. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function injectAdmin(html: string, ctx: AdminContext): string {
  const block = `${ADMIN_START}
<script>window.__RR = ${scriptJson(ctx)};</script>
<link rel="stylesheet" href="/assets/admin/admin.css">
<script type="module" src="/assets/admin/admin.js"></script>
${ADMIN_END}`;
  if (BODY_END_RE.test(html)) return html.replace(BODY_END_RE, () => block + "\n</body>");
  return html + "\n" + block;
}
```

- [ ] **Step 5.4: Wire it into `serve.ts`**

Add to the imports:

```typescript
import { injectAdmin } from "./admin.ts";
import type { AdminContext } from "./admin.ts";
```

Add the asset route regex next to the others:

```typescript
const ADMIN_ASSET_RE = /^\/assets\/admin\/([A-Za-z0-9_-]+\.(?:js|css))$/;
```

In `makeHandler`'s returned function, after the `apple-touch-icon.png` line, add (no-cache so bundle
edits show on refresh, like everything else on this server):

```typescript
const adminAsset = path.match(ADMIN_ASSET_RE);
if (adminAsset) {
  const type = adminAsset[1].endsWith(".css")
    ? "text/css; charset=utf-8"
    : "text/javascript; charset=utf-8";
  try {
    return new Response(await Deno.readFile(join(ROOT, "assets/admin", adminAsset[1])), {
      headers: { "content-type": type, "cache-control": "no-cache" },
    });
  } catch {
    return notice("Not found.", 404);
  }
}
```

Replace the two `TODO(admin)` returns:

```typescript
if (path === "/") {
  const docs: Record<string, { review: boolean; visibility: string }> = {};
  for (const t of corpus) {
    for (const d of t.docs) {
      docs[d.slug] = { review: d.review === true, visibility: d.visibility ?? "private" };
    }
  }
  const ctx: AdminContext = { page: "index", readonly: opts.readonly, docs };
  return page(injectAdmin(renderIndex(corpus), ctx));
}
```

```typescript
const html = await transformDoc(corpus, found.topic, found.doc);
const ctx: AdminContext = {
  page: "doc",
  readonly: opts.readonly,
  doc: {
    slug: found.doc.slug,
    review: found.doc.review === true,
    visibility: found.doc.visibility ?? "private",
  },
};
return page(injectAdmin(html, ctx));
```

- [ ] **Step 5.5: Run the full suite**

Run: `deno task test` Expected: ALL PASS (including the Task 4 serve tests — they assert content the
injection doesn't disturb).

- [ ] **Step 5.6: Format, lint, commit**

```bash
deno fmt admin.ts admin_test.ts serve.ts && deno lint
git add admin.ts admin_test.ts serve.ts
git commit -m "admin: server-injected context + bundle routes, publish-purity guards"
```

---

### Task 6: the browser admin layer (`admin.css` + `admin.js`)

**Files:**

- Create: `assets/admin/admin.css`, `assets/admin/admin.js`

Browser-only code — no Deno unit tests (the testable core, anchoring, lives in `anchor.js` and is
already covered). Verified by the smoke script in Step 6.4 and end-to-end in Task 8.

- [ ] **Step 6.1: Create `assets/admin/admin.css`**

```css
/* Reading Room — admin layer (served only by serve.ts; never published).
   Colors ride the editorial CSS variables, so the espresso theme
   (:root[data-theme="dark"]) restyles all of this for free. */

.rradmin-manage {
  position: fixed;
  bottom: 18px;
  left: 18px;
  z-index: 1100;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--copper, #a85a1a);
  background: var(--bg-soft, #ece4d2);
  border: 1px solid var(--rule-strong, #8a7e5e);
  border-radius: 2px;
  padding: 6px 11px;
  cursor: pointer;
}
.rradmin-manage:hover {
  color: var(--copper-soft, #c87a2f);
  border-color: var(--copper, #a85a1a);
}
.rradmin-manage[aria-pressed="true"] {
  color: var(--bg, #f3ecdd);
  background: var(--copper, #a85a1a);
  border-color: var(--copper, #a85a1a);
}

.rradmin-controls {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed var(--rule, #c9bfa3);
}
.rradmin-controls button {
  appearance: none;
  background: transparent;
  border: 1px solid var(--rule-strong, #8a7e5e);
  border-radius: 2px;
  color: var(--ink-soft, #3a3a36);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 4px 9px;
  cursor: pointer;
}
.rradmin-controls button:hover {
  color: var(--copper, #a85a1a);
  border-color: var(--copper, #a85a1a);
}
.rradmin-controls button.rradmin-on {
  color: var(--copper, #a85a1a);
  border-color: var(--copper, #a85a1a);
  background: rgba(168, 90, 26, 0.07);
}
.rradmin-controls button.rradmin-armed {
  color: #8a3030;
  border-color: #8a3030;
  background: rgba(138, 48, 48, 0.07);
}

.rradmin-cluster {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
.rradmin-cluster button {
  appearance: none;
  background: transparent;
  border: 1px solid var(--rule-strong, #8a7e5e);
  border-radius: 2px;
  color: var(--ink-mute, #6b6357);
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  padding: 3px 8px;
  cursor: pointer;
}
.rradmin-cluster button:hover {
  color: var(--copper, #a85a1a);
  border-color: var(--copper, #a85a1a);
}
.rradmin-cluster button.rradmin-on {
  color: var(--copper, #a85a1a);
  border-color: var(--copper, #a85a1a);
  background: rgba(168, 90, 26, 0.07);
}

.rradmin-mark {
  position: absolute;
  z-index: 55;
  appearance: none;
  background: transparent;
  border: none;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 13px;
  color: var(--copper, #a85a1a);
  opacity: 0.65;
  cursor: pointer;
  padding: 2px 6px;
}
.rradmin-mark:hover {
  opacity: 1;
}

.rradmin-fab {
  position: absolute;
  z-index: 1150;
  appearance: none;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 9.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--copper, #a85a1a);
  background: var(--bg-soft, #ece4d2);
  border: 1px solid var(--copper, #a85a1a);
  border-radius: 2px;
  padding: 5px 10px;
  cursor: pointer;
}
.rradmin-fab:hover {
  color: var(--bg, #f3ecdd);
  background: var(--copper, #a85a1a);
}

.rradmin-panel {
  position: absolute;
  z-index: 1200;
  width: min(340px, 86vw);
  background: var(--bg-soft, #ece4d2);
  border: 1px solid var(--rule-strong, #8a7e5e);
  border-radius: 2px;
  padding: 14px 16px;
  box-shadow: 0 6px 24px rgba(31, 58, 50, 0.18);
  font-family: "Source Serif 4", Georgia, serif;
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--ink-soft, #3a3a36);
}
.rradmin-panel .rradmin-eyebrow {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 9px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--copper, #a85a1a);
  margin: 0 0 8px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}
.rradmin-panel .rradmin-quote {
  font-style: italic;
  color: var(--ink-mute, #6b6357);
  border-left: 2px solid var(--rule, #c9bfa3);
  padding-left: 10px;
  margin: 0 0 10px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rradmin-panel textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 72px;
  resize: vertical;
  font-family: "Source Serif 4", Georgia, serif;
  font-size: 14.5px;
  line-height: 1.5;
  color: var(--ink, #000);
  background: var(--bg, #f3ecdd);
  border: 1px solid var(--rule, #c9bfa3);
  border-radius: 2px;
  padding: 8px 10px;
}
.rradmin-panel textarea:focus {
  outline: none;
  border-color: var(--copper, #a85a1a);
}
.rradmin-panel .rradmin-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 10px;
}
.rradmin-panel .rradmin-row button {
  appearance: none;
  background: transparent;
  border: 1px solid var(--rule-strong, #8a7e5e);
  border-radius: 2px;
  color: var(--ink-soft, #3a3a36);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 4px 9px;
  cursor: pointer;
}
.rradmin-panel .rradmin-row button:hover {
  color: var(--copper, #a85a1a);
  border-color: var(--copper, #a85a1a);
}
.rradmin-panel .rradmin-row button.rradmin-primary {
  color: var(--copper, #a85a1a);
  border-color: var(--copper, #a85a1a);
}
.rradmin-panel .rradmin-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 50vh;
  overflow: auto;
}
.rradmin-panel .rradmin-list li {
  padding: 8px 0;
  border-top: 1px dashed var(--rule, #c9bfa3);
  display: flex;
  gap: 10px;
  align-items: baseline;
  justify-content: space-between;
}
.rradmin-panel .rradmin-list li:first-child {
  border-top: none;
}
.rradmin-panel .rradmin-list .rradmin-jump {
  cursor: pointer;
  flex: 1;
}
.rradmin-panel .rradmin-list .rradmin-jump:hover {
  color: var(--copper, #a85a1a);
}
.rradmin-panel .rradmin-list .rradmin-orphan {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 8.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-mute, #6b6357);
}

.rradmin-toast {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1300;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--copper, #a85a1a);
  background: var(--bg-soft, #ece4d2);
  border: 1px solid var(--rule-strong, #8a7e5e);
  border-radius: 2px;
  padding: 6px 12px;
  opacity: 0;
  transition: opacity 0.25s;
  pointer-events: none;
}
.rradmin-toast.rradmin-show {
  opacity: 1;
}

::highlight(rradmin) {
  background: rgba(168, 90, 26, 0.20);
}

@media print {
  .rradmin-manage,
  .rradmin-controls,
  .rradmin-cluster,
  .rradmin-mark,
  .rradmin-panel,
  .rradmin-fab,
  .rradmin-toast {
    display: none !important;
  }
}
```

- [ ] **Step 6.2: Create `assets/admin/admin.js`**

```javascript
/**
 * Reading Room — browser admin layer (served only by serve.ts; never
 * published). Reads its page context from window.__RR (injected by admin.ts):
 *   index → manage mode: per-card review/visibility/remove controls
 *   doc   → breadcrumb cluster (review chip, § notes) + anchored marginalia
 * All state changes go through /api/ and finish with a reload (the server
 * re-renders; index grouping like "For Review" stays correct for free).
 */
import { describeRange, findAnchor } from "./anchor.js";

const ctx = window.__RR;
if (ctx && ctx.page === "index") initIndex(ctx);
else if (ctx && ctx.page === "doc") initDoc(ctx);

// --- shared helpers ----------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch (_) { /* keep status text */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  node.dataset.rradmin = "1";
  return node;
}

let toastNode = null;
let toastTimer = 0;
function toast(msg) {
  if (!toastNode) {
    toastNode = el("div", "rradmin-toast");
    document.body.appendChild(toastNode);
  }
  toastNode.textContent = msg;
  toastNode.classList.add("rradmin-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove("rradmin-show"), 2200);
}

function run(promise, okMsg) {
  promise
    .then(() => {
      if (okMsg) toast(okMsg);
      location.reload();
    })
    .catch((err) => toast(`failed: ${err.message}`));
}

// --- index: § manage mode ----------------------------------------------------

function initIndex(ctx) {
  if (ctx.readonly) return; // view-only exposure: no management layer at all
  const KEY = "rradmin-manage";
  const btn = el("button", "rradmin-manage", "§ Manage");
  btn.type = "button";
  document.body.appendChild(btn);

  let on = false;
  try {
    on = sessionStorage.getItem(KEY) === "1";
  } catch (_) { /* storage unavailable */ }

  function setMode(next) {
    on = next;
    btn.setAttribute("aria-pressed", String(on));
    try {
      sessionStorage.setItem(KEY, on ? "1" : "0");
    } catch (_) { /* storage unavailable */ }
    document.querySelectorAll(".rradmin-controls").forEach((c) => c.remove());
    if (on) document.querySelectorAll("a.card").forEach(addControls);
  }

  function addControls(card) {
    const href = card.getAttribute("href") || "";
    const m = href.match(/^\/docs\/([A-Za-z0-9_-]+)$/);
    if (!m) return;
    const slug = m[1];
    const state = ctx.docs[slug];
    if (!state) return;

    const row = el("div", "rradmin-controls");
    // every click inside the row must not follow the card link
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const review = el(
      "button",
      state.review ? "rradmin-on" : "",
      `review · ${state.review ? "on" : "off"}`,
    );
    review.type = "button";
    review.addEventListener(
      "click",
      () => run(api("PATCH", `/api/docs/${slug}`, { review: !state.review })),
    );

    const vis = el("button", state.visibility === "shared" ? "rradmin-on" : "", state.visibility);
    vis.type = "button";
    vis.addEventListener("click", () =>
      run(api("PATCH", `/api/docs/${slug}`, {
        visibility: state.visibility === "shared" ? "private" : "shared",
      })));

    const remove = el("button", "", "remove");
    remove.type = "button";
    let armed = false;
    let disarmTimer = 0;
    remove.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        remove.textContent = "confirm?";
        remove.classList.add("rradmin-armed");
        disarmTimer = setTimeout(() => {
          armed = false;
          remove.textContent = "remove";
          remove.classList.remove("rradmin-armed");
        }, 3000);
        return;
      }
      clearTimeout(disarmTimer);
      run(api("DELETE", `/api/docs/${slug}`), "removed (file kept)");
    });

    row.append(review, vis, remove);
    card.appendChild(row);
  }

  btn.addEventListener("click", () => setMode(!on));
  setMode(on);
}

// --- doc page: cluster + marginalia -------------------------------------------

function initDoc(ctx) {
  const bar = document.querySelector("[data-library-nav] > div");
  const cluster = el("span", "rradmin-cluster");
  if (bar) bar.appendChild(cluster);

  if (!ctx.readonly && bar) {
    const chip = el(
      "button",
      ctx.doc.review ? "rradmin-on" : "",
      ctx.doc.review ? "▸ in review — promote" : "mark for review",
    );
    chip.type = "button";
    chip.title = ctx.doc.review ? "Promote out of review" : "Pin to For Review";
    chip.addEventListener(
      "click",
      () => run(api("PATCH", `/api/docs/${ctx.doc.slug}`, { review: !ctx.doc.review })),
    );
    cluster.appendChild(chip);
  }

  const notesBtn = el("button", "", "§ …");
  notesBtn.type = "button";
  notesBtn.title = "Annotations";
  cluster.appendChild(notesBtn);

  // --- text extraction shared by anchoring + selection capture
  const SKIP =
    "[data-library-nav],[data-rradmin],.edtheme,.edzoom-overlay,.edzoom-controls,script,style,noscript";
  function collectText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return n.parentElement && n.parentElement.closest(SKIP)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = "";
    const spans = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      spans.push({ node: n, start: text.length });
      text += n.nodeValue;
    }
    return { text, spans };
  }

  function rangeFromOffsets(spans, start, end) {
    const range = document.createRange();
    let started = false;
    for (const sp of spans) {
      const len = sp.node.nodeValue.length;
      if (!started && start < sp.start + len) {
        range.setStart(sp.node, Math.max(0, start - sp.start));
        started = true;
      }
      if (started && end <= sp.start + len) {
        range.setEnd(sp.node, Math.max(0, end - sp.start));
        return range;
      }
    }
    return null;
  }

  function offsetsFromSelection(spans, range) {
    let start = -1;
    let end = -1;
    for (const sp of spans) {
      if (!range.intersectsNode(sp.node)) continue;
      if (start === -1) {
        start = sp.node === range.startContainer ? sp.start + range.startOffset : sp.start;
      }
      end = sp.node === range.endContainer
        ? sp.start + range.endOffset
        : sp.start + sp.node.nodeValue.length;
    }
    return start === -1 || end <= start ? null : { start, end };
  }

  // --- marginalia rendering
  let comments = [];
  let anchored = new Map(); // id → Range
  let markLayer = null;
  let panel = null;

  function closePanel() {
    if (panel) panel.remove();
    panel = null;
    if (window.CSS && CSS.highlights) CSS.highlights.delete("rradmin");
  }

  function openPanel(x, y, build) {
    closePanel();
    panel = el("div", "rradmin-panel");
    build(panel);
    document.body.appendChild(panel);
    const w = panel.offsetWidth;
    panel.style.left = `${
      Math.max(8, Math.min(x, document.documentElement.clientWidth - w - 8))
    }px`;
    panel.style.top = `${y}px`;
  }

  function highlight(range) {
    if (window.CSS && CSS.highlights && typeof Highlight === "function") {
      CSS.highlights.set("rradmin", new Highlight(range));
    }
  }

  function renderMarks() {
    if (markLayer) markLayer.remove();
    markLayer = el("div", "");
    markLayer.style.position = "absolute";
    markLayer.style.top = "0";
    markLayer.style.left = "0";
    document.body.appendChild(markLayer);
    anchored = new Map();

    const { text, spans } = collectText();
    const placed = [];
    for (const c of comments) {
      const hit = findAnchor(text, c);
      if (!hit) continue;
      const range = rangeFromOffsets(spans, hit.start, hit.end);
      if (!range) continue;
      anchored.set(c.id, range);

      const rect = range.getBoundingClientRect();
      const blockEl = range.startContainer.parentElement;
      const block = blockEl ? blockEl.getBoundingClientRect() : rect;
      let top = rect.top + window.scrollY;
      for (const p of placed) if (Math.abs(p - top) < 20) top = p + 20;
      placed.push(top);

      const mark = el("button", "rradmin-mark", "§");
      mark.type = "button";
      mark.title = c.note.slice(0, 80);
      mark.style.top = `${top - 2}px`;
      mark.style.left = `${
        Math.min(block.right + 10 + window.scrollX, document.documentElement.clientWidth - 30)
      }px`;
      mark.addEventListener("click", (e) => {
        e.stopPropagation();
        highlight(range);
        openNotePanel(c, range, e.pageX, e.pageY + 14);
      });
      markLayer.appendChild(mark);
    }
    notesBtn.textContent = `§ ${comments.length}`;
  }

  function openNotePanel(c, range, x, y) {
    openPanel(x, y, (p) => {
      const eyebrow = el("p", "rradmin-eyebrow");
      eyebrow.append(
        el("span", "", new Date(c.created).toISOString().slice(0, 10).replaceAll("-", "·")),
      );
      const quote = el("p", "rradmin-quote", c.quote);
      const note = el("p", "", c.note);
      const row = el("div", "rradmin-row");
      const close = el("button", "", "close");
      close.type = "button";
      close.addEventListener("click", closePanel);
      row.appendChild(close);
      if (!ctx.readonly) {
        const del = el("button", "", "delete");
        del.type = "button";
        del.addEventListener("click", () => {
          api("DELETE", `/api/docs/${ctx.doc.slug}/comments/${c.id}`)
            .then(() => {
              closePanel();
              return refresh();
            })
            .then(() => toast("annotation removed"))
            .catch((err) => toast(`failed: ${err.message}`));
        });
        row.appendChild(del);
      }
      p.append(eyebrow, quote, note, row);
    });
  }

  function openListPanel() {
    const rect = notesBtn.getBoundingClientRect();
    openPanel(rect.left + window.scrollX - 200, rect.bottom + window.scrollY + 10, (p) => {
      const eyebrow = el("p", "rradmin-eyebrow", `§ annotations — ${comments.length}`);
      p.appendChild(eyebrow);
      if (comments.length === 0) {
        p.appendChild(el("p", "", "None yet. Select a passage to annotate it."));
      } else {
        const list = el("ul", "rradmin-list");
        for (const c of comments) {
          const li = el("li", "");
          const jump = el(
            "span",
            "rradmin-jump",
            c.note.length > 70 ? c.note.slice(0, 70) + "…" : c.note,
          );
          const range = anchored.get(c.id);
          if (range) {
            jump.addEventListener("click", () => {
              closePanel();
              const target = range.startContainer.parentElement;
              if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
              highlight(range);
            });
          } else {
            li.appendChild(el("span", "rradmin-orphan", "unanchored"));
          }
          li.prepend(jump);
          if (!ctx.readonly) {
            const del = el("button", "", "×");
            del.type = "button";
            del.title = "Delete annotation";
            del.style.border = "none";
            del.style.background = "transparent";
            del.style.cursor = "pointer";
            del.style.color = "inherit";
            del.addEventListener("click", () => {
              api("DELETE", `/api/docs/${ctx.doc.slug}/comments/${c.id}`)
                .then(() => refresh(true))
                .catch((err) => toast(`failed: ${err.message}`));
            });
            li.appendChild(del);
          }
          list.appendChild(li);
        }
        p.appendChild(list);
      }
      const row = el("div", "rradmin-row");
      const close = el("button", "", "close");
      close.type = "button";
      close.addEventListener("click", closePanel);
      row.appendChild(close);
      p.appendChild(row);
    });
  }

  async function refresh(reopenList = false) {
    comments = await api("GET", `/api/docs/${ctx.doc.slug}/comments`);
    renderMarks();
    if (reopenList) openListPanel();
  }

  notesBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel) closePanel();
    else openListPanel();
  });

  // --- creating annotations from a selection
  let fab = null;
  function hideFab() {
    if (fab) fab.remove();
    fab = null;
  }

  function selectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const elNode = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (!elNode || elNode.closest(SKIP)) return null;
    return range;
  }

  function showFab() {
    hideFab();
    const range = selectionRange();
    if (!range) return;
    const rect = range.getBoundingClientRect();
    fab = el("button", "rradmin-fab", "§ annotate");
    fab.type = "button";
    // keep the selection alive when the button is pressed
    fab.addEventListener("mousedown", (e) => e.preventDefault());
    fab.addEventListener("click", () => {
      const r = selectionRange();
      if (!r) return hideFab();
      const { text, spans } = collectText();
      const offsets = offsetsFromSelection(spans, r);
      hideFab();
      if (!offsets) return toast("could not anchor that selection");
      const desc = describeRange(text, offsets.start, offsets.end);
      openComposer(desc, rect);
    });
    fab.style.top = `${rect.bottom + window.scrollY + 8}px`;
    fab.style.left = `${
      Math.min(rect.right + window.scrollX - 40, document.documentElement.clientWidth - 130)
    }px`;
    document.body.appendChild(fab);
  }

  function openComposer(desc, anchorRect) {
    openPanel(
      anchorRect.left + window.scrollX,
      anchorRect.bottom + window.scrollY + 12,
      (p) => {
        const eyebrow = el("p", "rradmin-eyebrow", "§ new annotation");
        const quote = el("p", "rradmin-quote", desc.quote);
        const input = el("textarea", "");
        input.placeholder = "Note…";
        const row = el("div", "rradmin-row");
        const cancel = el("button", "", "cancel");
        cancel.type = "button";
        cancel.addEventListener("click", closePanel);
        const save = el("button", "rradmin-primary", "save");
        save.type = "button";
        save.addEventListener("click", () => {
          const note = input.value.trim();
          if (!note) return toast("write a note first");
          api("POST", `/api/docs/${ctx.doc.slug}/comments`, { ...desc, note })
            .then(() => {
              closePanel();
              return refresh();
            })
            .then(() => toast("noted"))
            .catch((err) => toast(`failed: ${err.message}`));
        });
        row.append(cancel, save);
        p.append(eyebrow, quote, input, row);
        input.focus();
      },
    );
  }

  if (!ctx.readonly) {
    document.addEventListener("mouseup", (e) => {
      if (e.target instanceof Element && (e.target.closest(".rradmin-panel,.rradmin-fab"))) return;
      setTimeout(showFab, 0);
    });
    document.addEventListener("keyup", (e) => {
      if (e.key === "Escape") {
        hideFab();
        closePanel();
      }
    });
  }
  document.addEventListener("mousedown", (e) => {
    if (panel && e.target instanceof Element && !e.target.closest(".rradmin-panel,.rradmin-mark")) {
      closePanel();
    }
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderMarks, 200);
  });

  refresh().catch((err) => toast(`annotations unavailable: ${err.message}`));
}
```

- [ ] **Step 6.3: Format and lint**

```bash
deno fmt assets/admin/admin.js assets/admin/admin.css && deno lint
```

(`deno lint` skips .css; admin.js must pass.)

- [ ] **Step 6.4: Smoke-check in a real server**

```bash
deno task serve 8499 &
sleep 1
curl -s http://127.0.0.1:8499/ | grep -c "RR-ADMIN"                       # ≥ 1
curl -s http://127.0.0.1:8499/assets/admin/admin.js | head -3             # the file, content-type js
curl -s http://127.0.0.1:8499/assets/admin/admin.css | head -3            # the css
curl -s http://127.0.0.1:8499/assets/admin/anchor.js | head -3            # importable by the module
curl -s http://127.0.0.1:8499/docs/about-this-library | grep -c "window.__RR"  # ≥ 1
curl -s "http://127.0.0.1:8499/assets/admin/../../registry.jsonc" -o /dev/null -w "%{http_code}\n"  # 404 (no traversal)
kill %1
```

- [ ] **Step 6.5: Run the full suite, commit**

```bash
deno task test
git add assets/admin/admin.css assets/admin/admin.js
git commit -m "admin: manage mode, review chip, anchored marginalia ui"
```

---

### Task 7: build filter + publish

**Files:**

- Modify: `build.ts`, `deno.jsonc`, `.gitignore`
- Create: `publish.ts`, `build_test.ts`, `publish_test.ts`

- [ ] **Step 7.1: Write the failing tests**

Create `build_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert@1";
import { filterShared } from "./build.ts";
import type { Topic } from "./render.ts";

const doc = (slug: string, visibility?: "private" | "shared") => ({
  slug,
  title: slug,
  kind: "k",
  desc: "d",
  footLeft: "l",
  footRight: "r",
  src: `${slug}.html`,
  ...(visibility ? { visibility } : {}),
});

const CORPUS: Topic[] = [
  {
    num: "§ 01",
    id: "a",
    name: "A",
    short: "A",
    docs: [doc("one", "shared"), doc("two", "private")],
  },
  { num: "§ 02", id: "b", name: "B", short: "B", docs: [doc("three", "private")] },
  { num: "§ 03", id: "c", name: "C", short: "C", docs: [doc("four")] }, // visibility absent → private
];

Deno.test("filterShared keeps only shared docs and drops empty topics", () => {
  const out = filterShared(CORPUS);
  assertEquals(out.map((t) => t.id), ["a"]);
  assertEquals(out[0].docs.map((d) => d.slug), ["one"]);
});

Deno.test("filterShared of an all-private corpus is empty", () => {
  assertEquals(filterShared([CORPUS[1]]), []);
});

Deno.test("filterShared does not mutate its input", () => {
  filterShared(CORPUS);
  assertEquals(CORPUS[0].docs.length, 2);
});
```

Create `publish_test.ts`:

```typescript
import { assertEquals } from "jsr:@std/assert@1";
import { parsePublishConfig, resolveCmd } from "./publish.ts";

Deno.test("resolveCmd substitutes {out} wherever it appears", () => {
  assertEquals(
    resolveCmd(["aws", "s3", "sync", "{out}", "s3://bucket"], "/tmp/.publish"),
    ["aws", "s3", "sync", "/tmp/.publish", "s3://bucket"],
  );
  assertEquals(resolveCmd(["echo", "{out}/{out}"], "X"), ["echo", "X/X"]);
});

Deno.test("parsePublishConfig accepts a valid config", () => {
  assertEquals(parsePublishConfig({ cmd: ["rsync", "-a", "{out}", "host:/srv"] }), {
    cmd: ["rsync", "-a", "{out}", "host:/srv"],
  });
});

Deno.test("parsePublishConfig rejects bad shapes with a reason", () => {
  assertEquals(typeof parsePublishConfig(null), "string");
  assertEquals(typeof parsePublishConfig({}), "string");
  assertEquals(typeof parsePublishConfig({ cmd: [] }), "string");
  assertEquals(typeof parsePublishConfig({ cmd: "aws s3 sync" }), "string");
  assertEquals(typeof parsePublishConfig({ cmd: ["aws", 3] }), "string");
});
```

- [ ] **Step 7.2: Run tests to verify they fail**

Run: `deno test --allow-read build_test.ts publish_test.ts` Expected: FAIL — `filterShared` not
exported / `publish.ts` not found.

- [ ] **Step 7.3: Rework `build.ts`**

Replace the whole file:

```typescript
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
 * import admin.ts or comments.ts (admin_test.ts pins that), so static output
 * carries no admin chrome and no annotations.
 *
 *   deno task build              # full corpus -> ./docs + ./index.html
 *   (publish.ts calls build() with outDir/sharedOnly for the remote subset)
 */
import { emptyDir, ensureDir } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { DOCS_OUT, loadCorpus, renderIndex, ROOT, transformDoc } from "./render.ts";
import type { Topic } from "./render.ts";

/** The publish subset: only visibility:shared docs, then only non-empty topics. */
export function filterShared(corpus: Topic[]): Topic[] {
  return corpus
    .map((t) => ({ ...t, docs: t.docs.filter((d) => d.visibility === "shared") }))
    .filter((t) => t.docs.length > 0);
}

export interface BuildOptions {
  outDir?: string; // default ROOT — today's layout (./docs + ./index.html)
  sharedOnly?: boolean; // default false — everything
}

export async function build(opts: BuildOptions = {}): Promise<{ docs: number; topics: number }> {
  const outDir = opts.outDir ?? ROOT;
  let corpus = await loadCorpus();
  if (opts.sharedOnly) corpus = filterShared(corpus);
  const docsOut = outDir === ROOT ? DOCS_OUT : join(outDir, "docs");
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
```

- [ ] **Step 7.4: Create `publish.ts`**

```typescript
#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * Publish the Reading Room — build the visibility:shared subset into
 * .publish/ (gitignored; the local full build in docs/ is untouched), then
 * hand the directory to the command configured in publish.jsonc:
 *
 *   { "cmd": ["aws", "s3", "sync", "{out}", "s3://my-bucket", "--delete"] }
 *
 * `{out}` is replaced with the absolute output directory. No publish.jsonc →
 * build only, print the directory and a hint. --dry-run → build, print the
 * resolved command, run nothing.
 *
 *   deno task publish [--dry-run]
 */
import { join } from "jsr:@std/path@1";
import { exists } from "jsr:@std/fs@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { build } from "./build.ts";
import { ROOT } from "./render.ts";

export interface PublishConfig {
  cmd: string[];
}

/** Validate the parsed publish.jsonc shape, or explain why not. */
export function parsePublishConfig(raw: unknown): PublishConfig | string {
  if (typeof raw !== "object" || raw === null) return "publish.jsonc must be a JSON object";
  const cmd = (raw as Record<string, unknown>).cmd;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === "string")) {
    return 'publish.jsonc needs "cmd": a non-empty array of strings';
  }
  return { cmd: cmd as string[] };
}

/** Substitute {out} into the configured argv. */
export function resolveCmd(cmd: string[], out: string): string[] {
  return cmd.map((a) => a.replaceAll("{out}", out));
}

if (import.meta.main) {
  const dryRun = Deno.args.includes("--dry-run");
  const out = join(ROOT, ".publish");
  const { docs } = await build({ outDir: out, sharedOnly: true });
  if (docs === 0) {
    console.log("\n  Note: no docs are visibility:shared — the published site would be empty.");
  }
  const cfgPath = join(ROOT, "publish.jsonc");
  if (!(await exists(cfgPath))) {
    console.log(`\n  Built shared subset -> ${out}`);
    console.log(`  No publish.jsonc — create one to push, e.g.:`);
    console.log(`    { "cmd": ["aws", "s3", "sync", "{out}", "s3://my-bucket", "--delete"] }`);
    Deno.exit(0);
  }
  const cfg = parsePublishConfig(parseJsonc(await Deno.readTextFile(cfgPath)));
  if (typeof cfg === "string") {
    console.error(`  publish.jsonc invalid: ${cfg}`);
    Deno.exit(1);
  }
  const argv = resolveCmd(cfg.cmd, out);
  if (dryRun) {
    console.log(`\n  dry-run — would run:\n    ${argv.join(" ")}`);
    Deno.exit(0);
  }
  console.log(`\n  Running: ${argv.join(" ")}\n`);
  const status = await new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  Deno.exit(status.code);
}
```

- [ ] **Step 7.5: Add the publish task to `deno.jsonc`**

After the `add-doc` task line:

```jsonc
// Build the visibility:shared subset into .publish/ and run the command
// configured in publish.jsonc ({out} → the output dir). --dry-run to preview.
"publish": "deno run --allow-read --allow-write --allow-run publish.ts",
```

- [ ] **Step 7.6: Ignore `.publish/` in `.gitignore`**

Append:

```gitignore
# Remote-publish staging (deno task publish)
/.publish/
```

- [ ] **Step 7.7: Run the suite and exercise the CLIs**

```bash
deno task test                       # ALL PASS
deno task build                      # unchanged behavior: ./docs + ./index.html
deno task publish --dry-run          # builds .publish/, prints the no-config hint
ls .publish                          # index.html, docs/, favicon.svg, apple-touch-icon.png
grep -rc "RR-ADMIN" .publish || true # 0 matches — publish purity, end to end
git status --short                   # .publish/ NOT listed (ignored); docs/ + index.html ignored already
```

- [ ] **Step 7.8: Format, lint, commit**

```bash
deno fmt build.ts build_test.ts publish.ts publish_test.ts && deno lint
git add build.ts build_test.ts publish.ts publish_test.ts deno.jsonc .gitignore
git commit -m "build/publish: shared-subset static publish via configurable command"
```

---

### Task 8: README + end-to-end verification

**Files:**

- Modify: `README.md`

- [ ] **Step 8.1: Update `README.md`**

1. In the `## Use it` code block, after the `deno task build` line, add:

```text
deno task publish            # build the shared subset + run publish.jsonc's command
```

2. After the `## Add or change a document` section, insert two new sections:

```markdown
## Manage from the browser

The live server is also the management surface (the static publish never carries any of this):

- **Index → § Manage** (bottom-left) reveals per-card controls: toggle `review`, flip
  `private`/`shared`, or `remove` (two-step confirm). Removal only deregisters the doc — the
  `_migrated/` copy stays on disk.
- **Doc pages** get a breadcrumb cluster: the review chip ("mark for review" / "in review —
  promote") and a `§ n` annotation count.
- Set `READONLY=1` to serve a view-only instance (mutation routes return 403, management UI hidden)
  — handy if an exposure should be look-don't-touch.

## Annotations

Select a passage on any doc page → **§ annotate** → write a note. Notes are anchored to the text
(quote + context, W3C-annotation style) and shown as copper `§` marks in the margin; click one to
read, jump, or delete. If a doc is re-authored and a quote disappears, the note survives as
"unanchored" in the `§ n` list. Storage is `comments/<slug>.json` sidecars — source HTML is never
modified, and annotations never appear in the static build.
```

3. Replace the `## Remote sharing` section body's first paragraph with:

```markdown
`deno task publish` builds the **`visibility: shared` subset** into `.publish/` and, if
`publish.jsonc` exists, hands it to your command:

    { "cmd": ["aws", "s3", "sync", "{out}", "s3://my-bucket", "--delete"] }

`{out}` is replaced with the absolute `.publish/` path; use `--dry-run` to preview. No config → it
builds and tells you where the files are. Put the result behind whatever auth your setup provides.
```

4. In the `## Layout` list, add after the `build.ts` line:

```markdown
- `publish.ts` — build the shared subset to `.publish/` + run the configured push command.
- `registry-edit.ts` — pure registry string surgery (used by add-doc and the management API).
- `comments.ts`, `comments/` — annotation store: one JSON sidecar per doc slug.
- `admin.ts`, `assets/admin/` — the serve-only management layer (manage mode, review chip,
  marginalia). Never part of static output.
```

- [ ] **Step 8.2: Full suite + fmt check**

```bash
deno task test          # ALL PASS
deno fmt --check README.md || deno fmt README.md
```

- [ ] **Step 8.3: End-to-end verification against the real server**

```bash
deno task serve 8499 &
sleep 1
# pages
curl -s http://127.0.0.1:8499/ | grep -c "§ 01"                          # index renders
curl -s http://127.0.0.1:8499/docs/about-this-library | grep -c "RR-ADMIN"  # admin injected
# review round-trip via API, visible in render
curl -s -X PATCH http://127.0.0.1:8499/api/docs/about-this-library -H 'content-type: application/json' -d '{"review":true}'
curl -s http://127.0.0.1:8499/ | grep -c "For Review"                    # ≥ 1
curl -s -X PATCH http://127.0.0.1:8499/api/docs/about-this-library -H 'content-type: application/json' -d '{"review":false}'
git diff --exit-code registry.jsonc                                      # byte-identical
# annotations
curl -s -X POST http://127.0.0.1:8499/api/docs/about-this-library/comments \
  -H 'content-type: application/json' \
  -d '{"quote":"Reading Room","prefix":"","suffix":"","note":"e2e check"}'
curl -s http://127.0.0.1:8499/api/docs/about-this-library/comments       # 1 comment
# clean up the comment + file
ID=$(curl -s http://127.0.0.1:8499/api/docs/about-this-library/comments | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s -X DELETE http://127.0.0.1:8499/api/docs/about-this-library/comments/$ID
kill %1
# readonly
READONLY=1 deno task serve 8498 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://127.0.0.1:8498/api/docs/about-this-library -H 'content-type: application/json' -d '{"review":true}'   # 403
kill %1
```

Then verify in a real browser (claude-in-chrome if available, else report curl-level results): load
`http://127.0.0.1:8499/`, toggle § Manage, check controls render in both themes; open the doc,
select text, create + delete an annotation.

- [ ] **Step 8.4: Final tidy + commit**

```bash
git status --short      # expect: only README.md modified (+ untracked _migrated copies & comments/ leftovers — leave untracked)
git add README.md
git commit -m "docs: manage mode, annotations, and publish workflow"
```

---

## Plan self-review (done at authoring time)

- **Spec coverage:** registry-edit (spec §architecture) → Task 1; comments store (§architecture,
  §API) → Task 2; anchoring (§marginalia) → Tasks 3/6; API + READONLY + atomic writes (§API) → Task
  4; injection + purity guards (§architecture, §testing) → Task 5; index/doc UI + marginalia (§UI) →
  Task 6; publish + filter + `.gitignore` (§publish) → Task 7; README + e2e (§testing) → Task 8.
  Non-goals respected (no upload, no comment editing, no auth, no framework).
- **Type consistency:** `DocPatch`/`UnknownSlugError` defined Task 1, consumed Task 4;
  `CommentInput`/`writeAtomic` defined Task 2, consumed Task 4; `AdminContext` defined Task 5,
  consumed Task 5's serve wiring; `build()/filterShared` defined Task 7, consumed by publish.ts
  Task 7.
- **Placeholders:** the two `TODO(admin)` comments in Task 4 are deliberate seams that Task 5
  removes (its Step 5.4 replaces those exact lines); no other TODO/TBD remains.
