# Reading Room Artifact Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, raw-served, tailnet-native artifact store to the Reading Room engine —
publish any web document or directory, get a durable `/artifacts/<slug>/` tailnet URL, browse a
gallery, and manage it via a localhost API and `reading-room artifact` CLI.

**Architecture:** A serve-only subsystem, mechanically parallel to peer discovery. A pure store
module (`src/artifacts.ts`) owns the content-home manifest (`artifacts.json`) and copy-in snapshots
(`artifacts/<slug>/…`); `serve.ts` gains a raw content route, a gallery route, and an
`/api/artifacts` management surface; `discovery.ts` gains a self-DNSName lookup for URL
construction; `cli.ts` gains an `artifact` subcommand that drives the API over `127.0.0.1`. Content
is served byte-for-byte — no editorial/admin transform. Nothing touches the build path.

**Tech Stack:** Deno, TypeScript (strict, no `any`), `@std/http@1` (`serveDir`/`serveFile`),
`@std/fs@1` (`copy`/`walk`/`ensureDir`/`exists`), `@std/path@1`, `@std/assert@1` for tests.
Published to JSR as `@tlockney/reading-room`.

## Global Constraints

Every task's requirements implicitly include these:

- **No `any`.** Use `unknown` and narrow with type guards (project rule).
- **Serve-only isolation.** `build.ts` / `render.ts` must never import `artifacts.ts`. Pinned by the
  import-closure walk in `src/admin_test.ts` (extend it in Task 7).
- **No new runtime permissions.** `serve` already carries unrestricted
  `--allow-read`/`--allow-write` and `--allow-run`. Do not add permission flags to the agent, the
  installed CLI, or the direct-run shebangs.
- **`READONLY=1` gates all mutation** (`POST`/`PUT`/`PATCH`/`DELETE`). Routing artifact mutations
  through the existing `api()` function inherits this automatically (it returns `403` for any
  non-`GET` under readonly).
- **Slugs are readable, deduped, and immutable** once created. Slug charset must satisfy the route
  regex `[A-Za-z0-9_-]+`.
- **Raw serving.** No `transformDoc` / `injectAdmin` / editorial bundle on artifact content.
- **Tailnet-only.** No Funnel, no public exposure paths.
- **Manifest is machine-managed plain JSON** (`artifacts.json`), written with `writeAtomic` — not
  JSONC, no comment-preservation surgery.
- **Commit messages never mention Claude/AI/automation.**
- **Before every commit:** `deno task test`, `deno fmt --check`, and `deno lint` must pass. Run
  `deno fmt` freely — the `fmt.exclude` fence protects pinned content.
- **Timestamps** use `new Date().toISOString()`; **ids/slug-dedupe** are deterministic (no
  randomness in slugs).

---

### Task 1: Artifact manifest model + pure helpers

**Files:**

- Create: `src/artifacts.ts`
- Test: `src/artifacts_test.ts`

**Interfaces:**

- Consumes: `writeAtomic` from `./comments.ts`; `@std/path@1`.
- Produces:
  - `interface Artifact { slug: string; title: string; entry: string | null; isDir: boolean; createdAt: string; updatedAt: string; bytes: number }`
  - `interface Manifest { artifacts: Artifact[] }`
  - `loadManifest(path: string): Promise<Artifact[]>`
  - `saveManifest(path: string, list: Artifact[]): Promise<void>`
  - `slugify(name: string): string`
  - `deriveSlug(name: string, taken: Iterable<string>): string`
  - `extractTitle(html: string): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// src/artifacts_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { deriveSlug, extractTitle, loadManifest, saveManifest, slugify } from "./artifacts.ts";

Deno.test("slugify lowercases and hyphenates", () => {
  assertEquals(slugify("Landing Page Mockup!"), "landing-page-mockup");
  assertEquals(slugify("  Q3 Report (final) "), "q3-report-final");
  assertEquals(slugify("already-ok_1"), "already-ok_1");
});

Deno.test("deriveSlug dedupes against taken slugs", () => {
  assertEquals(deriveSlug("mockup", []), "mockup");
  assertEquals(deriveSlug("Mockup", ["mockup"]), "mockup-2");
  assertEquals(deriveSlug("mockup", ["mockup", "mockup-2"]), "mockup-3");
});

Deno.test("deriveSlug falls back when a name slugifies to empty", () => {
  assertEquals(deriveSlug("!!!", []), "artifact");
  assertEquals(deriveSlug("***", ["artifact"]), "artifact-2");
});

Deno.test("extractTitle reads the first <title>, else null", () => {
  assertEquals(extractTitle("<html><head><title> Hi There </title></head></html>"), "Hi There");
  assertEquals(extractTitle("<p>no title</p>"), null);
});

Deno.test("manifest round-trips; missing file loads as empty", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "artifacts.json");
  assertEquals(await loadManifest(path), []);
  const list = [{
    slug: "a",
    title: "A",
    entry: "index.html",
    isDir: true,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    bytes: 10,
  }];
  await saveManifest(path, list);
  assertEquals(await loadManifest(path), list);
  await Deno.remove(dir, { recursive: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/artifacts_test.ts` Expected: FAIL — `Module not found` / `artifacts.ts`
does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/artifacts.ts
/**
 * Reading Room — artifact store (serve-only). A persistent, raw-served sibling
 * to the curated library: publish an arbitrary web document or directory, get a
 * durable /artifacts/<slug>/ URL. Content is copied into the content home
 * (artifacts/<slug>/…) and recorded in a machine-managed manifest
 * (artifacts.json). build.ts MUST NOT import this module (serve-only, like
 * discovery.ts; build-purity is pinned in admin_test.ts).
 */
import { writeAtomic } from "./comments.ts";

export interface Artifact {
  slug: string;
  title: string;
  entry: string | null; // file served at the slug root; null → directory listing
  isDir: boolean;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  bytes: number;
}

export interface Manifest {
  artifacts: Artifact[];
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** A readable, unique slug: slugify `name`, fall back to "artifact" when it
 * reduces to empty, then suffix -2, -3, … until it clears `taken`. */
export function deriveSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name) || "artifact";
  if (!used.has(base)) return base;
  for (let n = 2;; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** First <title> text, trimmed; null when absent. */
export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = m?.[1]?.trim();
  return text ? text : null;
}

export async function loadManifest(path: string): Promise<Artifact[]> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
    if (typeof parsed !== "object" || parsed === null) return [];
    const list = (parsed as Record<string, unknown>).artifacts;
    return Array.isArray(list) ? list as Artifact[] : [];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

export async function saveManifest(path: string, list: Artifact[]): Promise<void> {
  const manifest: Manifest = { artifacts: list };
  await writeAtomic(path, JSON.stringify(manifest, null, 2) + "\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test src/artifacts_test.ts` Expected: PASS (5 tests).

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/artifacts.ts src/artifacts_test.ts && deno lint src/artifacts.ts
git add src/artifacts.ts src/artifacts_test.ts
git commit -m "feat(artifacts): manifest model + slug/title helpers"
```

---

### Task 2: Copy-in publish / update / remove

**Files:**

- Modify: `src/artifacts.ts`
- Test: `src/artifacts_test.ts`

**Interfaces:**

- Consumes: Task 1 exports; `@std/fs@1` (`copy`, `ensureDir`, `exists`, `walk`), `@std/path@1`
  (`basename`, `join`).
- Produces:
  - `publishArtifact(opts: { artifactsDir: string; manifestPath: string; srcPath: string; name?: string; title?: string }): Promise<Artifact>`
  - `updateArtifact(opts: { artifactsDir: string; manifestPath: string; slug: string; srcPath: string }): Promise<Artifact | null>`
  - `setArtifactTitle(opts: { manifestPath: string; slug: string; title: string }): Promise<Artifact | null>`
  - `removeArtifact(opts: { artifactsDir: string; manifestPath: string; slug: string }): Promise<boolean>`
  - `dirSize(path: string): Promise<number>`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/artifacts_test.ts
import { publishArtifact, removeArtifact, setArtifactTitle, updateArtifact } from "./artifacts.ts";
import { exists } from "jsr:@std/fs@1";

/** A temp content home + a source dir to build inputs in. */
async function scratch(): Promise<{ artifactsDir: string; manifestPath: string; srcDir: string }> {
  const root = await Deno.makeTempDir();
  const srcDir = join(root, "src");
  await Deno.mkdir(srcDir);
  return {
    artifactsDir: join(root, "artifacts"),
    manifestPath: join(root, "artifacts.json"),
    srcDir,
  };
}

Deno.test("publish a single HTML file: copy-in, title from <title>, entry=basename", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const file = join(srcDir, "report.html");
  await Deno.writeTextFile(
    file,
    "<html><head><title>Q3 Report</title></head><body>x</body></html>",
  );

  const art = await publishArtifact({ artifactsDir, manifestPath, srcPath: file });

  assertEquals(art.slug, "report");
  assertEquals(art.title, "Q3 Report");
  assertEquals(art.entry, "report.html");
  assertEquals(art.isDir, false);
  assertEquals(art.bytes > 0, true);
  assertEquals(await exists(join(artifactsDir, "report", "report.html")), true);
  assertEquals((await loadManifest(manifestPath)).length, 1);
});

Deno.test("publish a directory: index.html becomes entry, name overrides slug", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const site = join(srcDir, "site");
  await Deno.mkdir(site);
  await Deno.writeTextFile(
    join(site, "index.html"),
    "<html><head><title>Home</title></head></html>",
  );
  await Deno.writeTextFile(join(site, "app.js"), "console.log(1)");

  const art = await publishArtifact({
    artifactsDir,
    manifestPath,
    srcPath: site,
    name: "My Mockup",
  });

  assertEquals(art.slug, "my-mockup");
  assertEquals(art.isDir, true);
  assertEquals(art.entry, "index.html");
  assertEquals(await exists(join(artifactsDir, "my-mockup", "app.js")), true);
});

Deno.test("update re-snapshots content and bumps updatedAt; slug + title stay", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const file = join(srcDir, "a.html");
  await Deno.writeTextFile(file, "<title>One</title>");
  const first = await publishArtifact({ artifactsDir, manifestPath, srcPath: file });
  await Deno.writeTextFile(file, "<title>Two</title>");

  const updated = await updateArtifact({
    artifactsDir,
    manifestPath,
    slug: first.slug,
    srcPath: file,
  });
  assertEquals(updated?.title, "One"); // title is not re-derived on update; slug is stable
  assertEquals(
    await Deno.readTextFile(join(artifactsDir, first.slug, "a.html")),
    "<title>Two</title>",
  );
  assertEquals(updated!.updatedAt >= first.updatedAt, true);
  assertEquals(
    await updateArtifact({ artifactsDir, manifestPath, slug: "nope", srcPath: file }),
    null,
  );
});

Deno.test("setArtifactTitle edits the display title only", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const file = join(srcDir, "a.html");
  await Deno.writeTextFile(file, "<title>Old</title>");
  const art = await publishArtifact({ artifactsDir, manifestPath, srcPath: file });

  const renamed = await setArtifactTitle({ manifestPath, slug: art.slug, title: "New Name" });
  assertEquals(renamed?.title, "New Name");
  assertEquals(renamed?.slug, art.slug); // slug unchanged
  assertEquals((await loadManifest(manifestPath))[0].title, "New Name");
  assertEquals(await setArtifactTitle({ manifestPath, slug: "nope", title: "x" }), null);
});

Deno.test("remove deletes the snapshot dir and manifest entry", async () => {
  const { artifactsDir, manifestPath, srcDir } = await scratch();
  const file = join(srcDir, "a.html");
  await Deno.writeTextFile(file, "<title>A</title>");
  const art = await publishArtifact({ artifactsDir, manifestPath, srcPath: file });

  assertEquals(await removeArtifact({ artifactsDir, manifestPath, slug: art.slug }), true);
  assertEquals(await exists(join(artifactsDir, art.slug)), false);
  assertEquals(await loadManifest(manifestPath), []);
  assertEquals(await removeArtifact({ artifactsDir, manifestPath, slug: "gone" }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/artifacts_test.ts` Expected: FAIL — `publishArtifact is not a function`
(not yet exported).

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/artifacts.ts
import { copy, ensureDir, exists, walk } from "jsr:@std/fs@1";
import { basename, join } from "jsr:@std/path@1";

/** Total size in bytes of a file or directory tree. */
export async function dirSize(path: string): Promise<number> {
  const stat = await Deno.stat(path);
  if (stat.isFile) return stat.size;
  let total = 0;
  for await (const entry of walk(path, { includeDirs: false, includeSymlinks: false })) {
    total += (await Deno.stat(entry.path)).size;
  }
  return total;
}

const HTML_RE = /\.html?$/i;

/** After content is at `dest`, decide the entry file + a title. */
async function resolveEntryAndTitle(
  dest: string,
  isDir: boolean,
  fileName: string,
  explicitTitle: string | undefined,
  slug: string,
): Promise<{ entry: string | null; title: string }> {
  const entry = isDir ? (await exists(join(dest, "index.html")) ? "index.html" : null) : fileName;
  if (explicitTitle) return { entry, title: explicitTitle };
  if (entry && HTML_RE.test(entry)) {
    const fromTitle = extractTitle(await Deno.readTextFile(join(dest, entry)));
    if (fromTitle) return { entry, title: fromTitle };
  }
  return { entry, title: slug };
}

export async function publishArtifact(opts: {
  artifactsDir: string;
  manifestPath: string;
  srcPath: string;
  name?: string;
  title?: string;
}): Promise<Artifact> {
  const stat = await Deno.stat(opts.srcPath); // throws if missing → surfaced as 400 by the API
  const isDir = stat.isDirectory;
  const fileName = basename(opts.srcPath);
  const list = await loadManifest(opts.manifestPath);
  const slug = deriveSlug(opts.name ?? fileName.replace(HTML_RE, ""), list.map((a) => a.slug));
  const dest = join(opts.artifactsDir, slug);

  await ensureDir(dest);
  await copy(opts.srcPath, isDir ? dest : join(dest, fileName), { overwrite: true });

  const { entry, title } = await resolveEntryAndTitle(dest, isDir, fileName, opts.title, slug);
  const now = new Date().toISOString();
  const art: Artifact = {
    slug,
    title,
    entry,
    isDir,
    createdAt: now,
    updatedAt: now,
    bytes: await dirSize(dest),
  };
  list.push(art);
  await saveManifest(opts.manifestPath, list);
  return art;
}

export async function updateArtifact(opts: {
  artifactsDir: string;
  manifestPath: string;
  slug: string;
  srcPath: string;
}): Promise<Artifact | null> {
  const list = await loadManifest(opts.manifestPath);
  const art = list.find((a) => a.slug === opts.slug);
  if (!art) return null;
  const stat = await Deno.stat(opts.srcPath);
  const isDir = stat.isDirectory;
  const fileName = basename(opts.srcPath);
  const dest = join(opts.artifactsDir, opts.slug);

  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await ensureDir(dest);
  await copy(opts.srcPath, isDir ? dest : join(dest, fileName), { overwrite: true });

  art.isDir = isDir;
  art.entry = isDir ? (await exists(join(dest, "index.html")) ? "index.html" : null) : fileName;
  art.bytes = await dirSize(dest);
  art.updatedAt = new Date().toISOString();
  await saveManifest(opts.manifestPath, list);
  return art;
}

/** Edit an artifact's display title in place; slug and content are untouched. */
export async function setArtifactTitle(opts: {
  manifestPath: string;
  slug: string;
  title: string;
}): Promise<Artifact | null> {
  const list = await loadManifest(opts.manifestPath);
  const art = list.find((a) => a.slug === opts.slug);
  if (!art) return null;
  art.title = opts.title;
  art.updatedAt = new Date().toISOString();
  await saveManifest(opts.manifestPath, list);
  return art;
}

export async function removeArtifact(opts: {
  artifactsDir: string;
  manifestPath: string;
  slug: string;
}): Promise<boolean> {
  const list = await loadManifest(opts.manifestPath);
  const keep = list.filter((a) => a.slug !== opts.slug);
  if (keep.length === list.length) return false;
  await Deno.remove(join(opts.artifactsDir, opts.slug), { recursive: true }).catch(() => {});
  await saveManifest(opts.manifestPath, keep);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test src/artifacts_test.ts` Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/artifacts.ts src/artifacts_test.ts && deno lint src/artifacts.ts
git add src/artifacts.ts src/artifacts_test.ts
git commit -m "feat(artifacts): copy-in publish, update, and remove"
```

---

### Task 3: Self-DNSName lookup + tailnet URL builder

**Files:**

- Modify: `src/discovery.ts`
- Modify: `src/artifacts.ts` (add `artifactUrl`)
- Test: `src/discovery_test.ts`, `src/artifacts_test.ts`

**Interfaces:**

- Consumes: `RunFn`, `defaultRun`, `TAILSCALE_BINS` (already in `discovery.ts` — export
  `TAILSCALE_BINS`/`defaultRun` if not already; both currently module-private, so add exports).
- Produces:
  - `parseSelfDnsName(raw: unknown): string | null` in `discovery.ts`
  - `selfDnsName(run?: RunFn): Promise<string | null>` in `discovery.ts`
  - `artifactUrl(dnsName: string, slug: string): string` in `artifacts.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/discovery_test.ts
import { parseSelfDnsName, selfDnsName } from "./discovery.ts";

Deno.test("parseSelfDnsName reads Self.DNSName and strips the trailing dot", () => {
  assertEquals(
    parseSelfDnsName({ Self: { DNSName: "studio.tail1234.ts.net." } }),
    "studio.tail1234.ts.net",
  );
  assertEquals(parseSelfDnsName({ Self: {} }), null);
  assertEquals(parseSelfDnsName({}), null);
  assertEquals(parseSelfDnsName("nope"), null);
});

Deno.test("selfDnsName runs tailscale status and parses Self", async () => {
  const fakeRun = (_cmd: string, _args: string[]) =>
    Promise.resolve({ code: 0, stdout: JSON.stringify({ Self: { DNSName: "h.tail1.ts.net." } }) });
  assertEquals(await selfDnsName(fakeRun), "h.tail1.ts.net");
});

Deno.test("selfDnsName returns null when tailscale fails", async () => {
  const fail = (_c: string, _a: string[]) => Promise.resolve({ code: 1, stdout: "" });
  assertEquals(await selfDnsName(fail), null);
});
```

```ts
// append to src/artifacts_test.ts
import { artifactUrl } from "./artifacts.ts";

Deno.test("artifactUrl builds a tailnet content URL", () => {
  assertEquals(
    artifactUrl("studio.tail1.ts.net", "mockup"),
    "https://studio.tail1.ts.net/artifacts/mockup/",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test src/discovery_test.ts src/artifacts_test.ts` Expected: FAIL —
`parseSelfDnsName`/`selfDnsName`/`artifactUrl` not exported.

- [ ] **Step 3: Write minimal implementations**

In `src/discovery.ts` — first make the existing constants reusable, then add the lookups. Change the
two `const` declarations to exported:

```ts
// change: const TAILSCALE_BINS = [ ... ]   →   export const TAILSCALE_BINS = [ ... ]
// change: const defaultRun: RunFn = ...     →   export const defaultRun: RunFn = ...
```

Then append:

```ts
/** Read Self.DNSName from `tailscale status --json`, trailing dot stripped. */
export function parseSelfDnsName(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const self = (raw as Record<string, unknown>).Self;
  if (typeof self !== "object" || self === null) return null;
  const dns = (self as Record<string, unknown>).DNSName;
  return typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null;
}

/** This node's tailnet DNS name, or null if tailscale is unavailable. */
export async function selfDnsName(run: RunFn = defaultRun): Promise<string | null> {
  for (const bin of TAILSCALE_BINS) {
    try {
      const { code, stdout } = await run(bin, ["status", "--json"]);
      if (code !== 0) continue;
      return parseSelfDnsName(JSON.parse(stdout));
    } catch {
      // try the next candidate binary path
    }
  }
  return null;
}
```

In `src/artifacts.ts` append:

```ts
/** Tailnet URL for an artifact's content root. */
export function artifactUrl(dnsName: string, slug: string): string {
  return `https://${dnsName}/artifacts/${slug}/`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test src/discovery_test.ts src/artifacts_test.ts` Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/discovery.ts src/discovery_test.ts src/artifacts.ts src/artifacts_test.ts
deno lint src/discovery.ts src/artifacts.ts
git add src/discovery.ts src/discovery_test.ts src/artifacts.ts src/artifacts_test.ts
git commit -m "feat(artifacts): tailnet self-DNSName lookup and URL builder"
```

---

### Task 4: Gallery renderer (pure)

**Files:**

- Modify: `src/artifacts.ts`
- Test: `src/artifacts_test.ts`

**Interfaces:**

- Consumes: `Artifact` (Task 1).
- Produces: `renderGallery(artifacts: Artifact[]): string` — a complete standalone HTML page (NOT
  the editorial bundle).

- [ ] **Step 1: Write the failing test**

```ts
// append to src/artifacts_test.ts
import { renderGallery } from "./artifacts.ts";

Deno.test("gallery renders a card per artifact with a content link", () => {
  const html = renderGallery([{
    slug: "mockup",
    title: "Landing <Page>",
    entry: "index.html",
    isDir: true,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T12:00:00.000Z",
    bytes: 2048,
  }]);
  assertEquals(html.includes(`href="/artifacts/mockup/"`), true);
  assertEquals(html.includes("Landing &lt;Page&gt;"), true); // title is escaped
  assertEquals(html.includes("Landing <Page>"), false);
});

Deno.test("gallery shows an empty state when there are no artifacts", () => {
  const html = renderGallery([]);
  assertEquals(html.toLowerCase().includes("no artifacts"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/artifacts_test.ts` Expected: FAIL — `renderGallery is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/artifacts.ts
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A light standalone gallery page — deliberately not the editorial bundle, so
 * it stays visually distinct from the curated library index. */
export function renderGallery(artifacts: Artifact[]): string {
  const cards = artifacts
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((a) => `
      <a class="card" href="/artifacts/${a.slug}/">
        <h2>${escHtml(a.title)}</h2>
        <p class="meta">${escHtml(a.updatedAt.slice(0, 10))} · ${humanBytes(a.bytes)}${
      a.isDir ? " · directory" : ""
    }</p>
        <code>/artifacts/${a.slug}/</code>
      </a>`)
    .join("");
  const body = artifacts.length
    ? `<div class="grid">${cards}</div>`
    : `<p class="empty">No artifacts yet. Publish one with <code>reading-room artifact &lt;path&gt;</code>.</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacts — Reading Room</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }
  .card { display: block; padding: 1rem; border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
          border-radius: 10px; text-decoration: none; color: inherit; }
  .card:hover { border-color: color-mix(in srgb, currentColor 45%, transparent); }
  .card h2 { font-size: 1.05rem; margin: 0 0 .35rem; }
  .meta { font-size: .8rem; opacity: .7; margin: 0 0 .5rem; }
  code { font-size: .8rem; opacity: .85; }
  .empty { opacity: .7; }
</style></head><body>
<h1>Artifacts</h1>
${body}
</body></html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test src/artifacts_test.ts` Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/artifacts.ts src/artifacts_test.ts && deno lint src/artifacts.ts
git add src/artifacts.ts src/artifacts_test.ts
git commit -m "feat(artifacts): standalone gallery renderer"
```

---

### Task 5: RoomContext wiring + serve content route + gallery route

**Files:**

- Modify: `src/config.ts` (add `artifactsDir`, `artifactsManifest` to `RoomContext` + `makeContext`)
- Modify: `src/serve.ts` (routes + `ServeOptions`)
- Test: `src/config_test.ts`, `src/serve_test.ts`

**Interfaces:**

- Consumes: `loadManifest`, `renderGallery` (artifacts.ts); `@std/http@1` `serveDir`/`serveFile`.
- Produces:
  - `RoomContext.artifactsDir: string`, `RoomContext.artifactsManifest: string`
  - `ServeOptions.selfDns?: () => Promise<string | null>` (added; used in Task 6)
  - Routes: `GET /artifacts` and `/artifacts/` → gallery; `GET /artifacts/<slug>` → 301 to
    `/artifacts/<slug>/`; `GET /artifacts/<slug>/<rest?>` → raw content.

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/config_test.ts
import { makeContext } from "./config.ts";
import { join } from "jsr:@std/path@1";

Deno.test("makeContext exposes artifacts paths", async () => {
  const ctx = await makeContext("/tmp/room");
  assertEquals(ctx.artifactsDir, join("/tmp/room", "artifacts"));
  assertEquals(ctx.artifactsManifest, join("/tmp/room", "artifacts.json"));
});
```

```ts
// append to src/serve_test.ts — mirror the existing handler-test setup in this file
// (makeContext over a temp root + makeHandler). Add:
import { publishArtifact } from "./artifacts.ts";

async function roomWithArtifact(): Promise<
  { ctx: Awaited<ReturnType<typeof makeContext>>; slug: string }
> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(join(root, "registry.jsonc"), "{ topics: [] }");
  const ctx = await makeContext(root);
  const src = join(root, "page.html");
  await Deno.writeTextFile(
    src,
    "<html><head><title>Mock</title></head><body>hello-artifact</body></html>",
  );
  const art = await publishArtifact({
    artifactsDir: ctx.artifactsDir,
    manifestPath: ctx.artifactsManifest,
    srcPath: src,
  });
  return { ctx, slug: art.slug };
}

Deno.test("GET /artifacts renders the gallery", async () => {
  const { ctx } = await roomWithArtifact();
  const h = makeHandler({ ctx, readonly: false });
  const res = await h(new Request("http://127.0.0.1/artifacts"));
  assertEquals(res.status, 200);
  assertEquals((await res.text()).includes("Artifacts"), true);
});

Deno.test("GET /artifacts/<slug> redirects to trailing slash", async () => {
  const { ctx, slug } = await roomWithArtifact();
  const h = makeHandler({ ctx, readonly: false });
  const res = await h(new Request(`http://127.0.0.1/artifacts/${slug}`));
  assertEquals(res.status, 301);
  assertEquals(res.headers.get("location"), `/artifacts/${slug}/`);
  await res.body?.cancel();
});

Deno.test("GET /artifacts/<slug>/ serves the raw file, no admin/editorial chrome", async () => {
  const { ctx, slug } = await roomWithArtifact();
  const h = makeHandler({ ctx, readonly: false });
  const res = await h(new Request(`http://127.0.0.1/artifacts/${slug}/`));
  const body = await res.text();
  assertEquals(res.status, 200);
  assertEquals(body.includes("hello-artifact"), true);
  assertEquals(body.includes("RR-ADMIN"), false);
});

Deno.test("GET unknown artifact slug is 404", async () => {
  const { ctx } = await roomWithArtifact();
  const h = makeHandler({ ctx, readonly: false });
  const res = await h(new Request("http://127.0.0.1/artifacts/nope/"));
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("path traversal out of an artifact is rejected", async () => {
  const { ctx, slug } = await roomWithArtifact();
  const h = makeHandler({ ctx, readonly: false });
  const res = await h(new Request(`http://127.0.0.1/artifacts/${slug}/..%2f..%2fregistry.jsonc`));
  assertEquals(res.status === 404 || res.status === 403, true);
  await res.body?.cancel();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test src/config_test.ts src/serve_test.ts` Expected: FAIL — `artifactsDir` missing /
`/artifacts` returns the "Not found." notice.

- [ ] **Step 3: Implement**

In `src/config.ts`, extend the interface and `makeContext`:

```ts
// in interface RoomContext, after commentsDir:
artifactsDir: string;
artifactsManifest: string;
```

```ts
// in makeContext's returned object, after commentsDir:
    artifactsDir: join(abs, "artifacts"),
    artifactsManifest: join(abs, "artifacts.json"),
```

In `src/serve.ts`:

```ts
// add imports near the discovery import:
import { serveDir, serveFile } from "jsr:@std/http@1/file-server";
import { loadManifest, renderGallery } from "./artifacts.ts";

// add a route regex near the others (top of file):
const ARTIFACT_RE = /^\/artifacts\/([A-Za-z0-9_-]+)(\/.*)?$/;
```

```ts
// add to ServeOptions:
export interface ServeOptions {
  ctx: RoomContext;
  readonly: boolean;
  discover?: () => Promise<Peer[]>;
  selfDns?: () => Promise<string | null>; // used by /api/artifacts to build tailnet URLs
}
```

Add an artifact-content handler function above `makeHandler`:

```ts
async function serveArtifact(req: Request, path: string, opts: ServeOptions): Promise<Response> {
  const m = path.match(ARTIFACT_RE);
  if (!m) return notice("Not found.", 404);
  const [, slug, rest] = m;
  const artifacts = await loadManifest(opts.ctx.artifactsManifest);
  const art = artifacts.find((a) => a.slug === slug);
  if (!art) return notice(`No such artifact: <b>${esc(slug)}</b>`, 404);

  const dir = `${opts.ctx.artifactsDir}/${slug}`;
  if (!rest) return redirect(`/artifacts/${slug}/`); // ensure a base for relative links
  if (rest === "/" && !art.isDir && art.entry) {
    return await serveFile(req, `${dir}/${art.entry}`);
  }
  // serveDir jails within fsRoot and 404s on traversal escapes.
  return await serveDir(req, {
    fsRoot: dir,
    urlRoot: `artifacts/${slug}`,
    showIndex: true,
    showDirListing: true,
    quiet: true,
  });
}
```

Wire routing into `makeHandler`, **before** the `loadCorpus` block (artifacts don't need the
registry). Place it right after the `if (path.startsWith("/api/")) return api(req, path, opts);`
line:

```ts
if (path === "/artifacts" || path === "/artifacts/") {
  if (req.method !== "GET") return notice("Method not allowed.", 405);
  return page(renderGallery(await loadManifest(opts.ctx.artifactsManifest)));
}
if (path.startsWith("/artifacts/")) {
  if (req.method !== "GET") return notice("Method not allowed.", 405);
  return serveArtifact(req, path, opts);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test src/config_test.ts src/serve_test.ts` Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/config.ts src/config_test.ts src/serve.ts src/serve_test.ts
deno lint src/config.ts src/serve.ts
git add src/config.ts src/config_test.ts src/serve.ts src/serve_test.ts
git commit -m "feat(artifacts): serve raw content + gallery routes"
```

---

### Task 6: `/api/artifacts` management API

**Files:**

- Modify: `src/serve.ts`
- Test: `src/serve_test.ts`

**Interfaces:**

- Consumes: `publishArtifact`, `updateArtifact`, `setArtifactTitle`, `removeArtifact`,
  `loadManifest`, `artifactUrl` (artifacts.ts); `selfDns` (Task 5); `exists` from `@std/fs@1`.
- Produces: routes under `/api/artifacts` handled inside the existing `api()` function (inherits the
  READONLY 403 guard).

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/serve_test.ts
Deno.test("POST /api/artifacts publishes and returns urls", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(join(root, "registry.jsonc"), "{ topics: [] }");
  const ctx = await makeContext(root);
  const src = join(root, "m.html");
  await Deno.writeTextFile(src, "<title>M</title>");
  const h = makeHandler({ ctx, readonly: false, selfDns: () => Promise.resolve("h.tail1.ts.net") });

  const res = await h(
    new Request("http://127.0.0.1/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: src }),
    }),
  );
  assertEquals(res.status, 201);
  const body = await res.json() as { slug: string; url: string; localUrl: string };
  assertEquals(body.slug, "m");
  assertEquals(body.url, "https://h.tail1.ts.net/artifacts/m/");
  assertEquals(body.localUrl.endsWith("/artifacts/m/"), true);
});

Deno.test("POST /api/artifacts with a missing path is 400", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(join(root, "registry.jsonc"), "{ topics: [] }");
  const ctx = await makeContext(root);
  const h = makeHandler({ ctx, readonly: false });
  const res = await h(
    new Request("http://127.0.0.1/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(root, "does-not-exist.html") }),
    }),
  );
  assertEquals(res.status, 400);
});

Deno.test("PATCH /api/artifacts/<slug> edits the title", async () => {
  const { ctx, slug } = await roomWithArtifact();
  const rw = makeHandler({ ctx, readonly: false });
  const res = await rw(
    new Request(`http://127.0.0.1/api/artifacts/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json() as { title: string }).title, "Renamed");
});

Deno.test("GET/DELETE /api/artifacts round-trip; mutations blocked under READONLY", async () => {
  const { ctx, slug } = await roomWithArtifact();

  const ro = makeHandler({ ctx, readonly: true });
  assertEquals(
    (await ro(new Request(`http://127.0.0.1/api/artifacts/${slug}`, { method: "DELETE" }))).status,
    403,
  );
  assertEquals(
    (await ro(
      new Request(`http://127.0.0.1/api/artifacts/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      }),
    )).status,
    403,
  );

  const rw = makeHandler({ ctx, readonly: false });
  const list = await (await rw(new Request("http://127.0.0.1/api/artifacts"))).json() as {
    slug: string;
  }[];
  assertEquals(list.some((a) => a.slug === slug), true);
  assertEquals(
    (await rw(new Request(`http://127.0.0.1/api/artifacts/${slug}`, { method: "DELETE" }))).status,
    200,
  );
  const after = await (await rw(new Request("http://127.0.0.1/api/artifacts"))).json() as {
    slug: string;
  }[];
  assertEquals(after.some((a) => a.slug === slug), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test src/serve_test.ts` Expected: FAIL — `/api/artifacts` returns `404 not found`.

- [ ] **Step 3: Implement**

Add imports to `src/serve.ts`:

```ts
import {
  artifactUrl,
  publishArtifact,
  removeArtifact,
  setArtifactTitle,
  updateArtifact,
} from "./artifacts.ts";
import { exists } from "jsr:@std/fs@1";
```

> `loadManifest` is already imported in `serve.ts` from Task 5; don't re-import it.

Add route regexes near the others:

```ts
const API_ARTIFACTS_RE = /^\/api\/artifacts\/?$/;
const API_ARTIFACT_RE = /^\/api\/artifacts\/([A-Za-z0-9_-]+)$/;
```

Inside `api()`, before the final `return jsonError("not found", 404);`, add the dispatch (the
top-of-`api()` guard already returns 403 for non-GET under readonly, so no per-verb readonly checks
are needed here):

```ts
if (API_ARTIFACTS_RE.test(path)) {
  if (req.method === "GET") return json(await loadManifest(opts.ctx.artifactsManifest));
  if (req.method === "POST") {
    const raw = await readJson(req);
    if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
    const o = raw as Record<string, unknown>;
    if (typeof o.path !== "string") return jsonError("path must be a string", 400);
    if (!(await exists(o.path))) return jsonError(`path not found: ${o.path}`, 400);
    const name = typeof o.name === "string" ? o.name : undefined;
    const title = typeof o.title === "string" ? o.title : undefined;
    const art = await publishArtifact({
      artifactsDir: opts.ctx.artifactsDir,
      manifestPath: opts.ctx.artifactsManifest,
      srcPath: o.path,
      name,
      title,
    });
    const dns = opts.selfDns ? await opts.selfDns() : null;
    return json({
      slug: art.slug,
      url: dns ? artifactUrl(dns, art.slug) : null,
      localUrl: `/artifacts/${art.slug}/`,
    }, 201);
  }
  return jsonError("method not allowed", 405);
}

const artMatch = path.match(API_ARTIFACT_RE);
if (artMatch) {
  const slug = artMatch[1];
  if (req.method === "PUT") {
    const raw = await readJson(req);
    if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
    const o = raw as Record<string, unknown>;
    if (typeof o.path !== "string") return jsonError("path must be a string", 400);
    if (!(await exists(o.path))) return jsonError(`path not found: ${o.path}`, 400);
    const updated = await updateArtifact({
      artifactsDir: opts.ctx.artifactsDir,
      manifestPath: opts.ctx.artifactsManifest,
      slug,
      srcPath: o.path,
    });
    return updated ? json(updated) : jsonError(`unknown artifact: ${slug}`, 404);
  }
  if (req.method === "PATCH") {
    const raw = await readJson(req);
    if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
    const o = raw as Record<string, unknown>;
    if (typeof o.title !== "string" || o.title.trim() === "") {
      return jsonError("title must be a non-empty string", 400);
    }
    const renamed = await setArtifactTitle({
      manifestPath: opts.ctx.artifactsManifest,
      slug,
      title: o.title,
    });
    return renamed ? json(renamed) : jsonError(`unknown artifact: ${slug}`, 404);
  }
  if (req.method === "DELETE") {
    const ok = await removeArtifact({
      artifactsDir: opts.ctx.artifactsDir,
      manifestPath: opts.ctx.artifactsManifest,
      slug,
    });
    return ok ? json({ ok: true, removed: slug }) : jsonError(`unknown artifact: ${slug}`, 404);
  }
  return jsonError("method not allowed", 405);
}
```

Finally, extend the existing `discovery.ts` import in `serve.ts` to add `selfDnsName` **without
dropping `buildIdentity`** (it backs the `/.well-known/reading-room.json` route). The line currently
reads:

```ts
import { buildIdentity, listTailscalePeers, makeCachedDiscover, probePeer } from "./discovery.ts";
```

Change it to:

```ts
import {
  buildIdentity,
  listTailscalePeers,
  makeCachedDiscover,
  probePeer,
  selfDnsName,
} from "./discovery.ts";
```

Then inject `selfDns` in `serveMain`, after `const discover = ...`:

```ts
const handler = makeHandler({ ctx, readonly, discover, selfDns: () => selfDnsName() });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test src/serve_test.ts` Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/serve.ts src/serve_test.ts && deno lint src/serve.ts
git add src/serve.ts src/serve_test.ts
git commit -m "feat(artifacts): /api/artifacts management routes"
```

---

### Task 7: Build-purity pin + public exports

**Files:**

- Modify: `src/admin_test.ts` (extend the import-closure assertion)
- Modify: `src/mod.ts` (export the artifact public surface)
- Test: `src/admin_test.ts`

**Interfaces:**

- Consumes: everything exported from `artifacts.ts`.
- Produces: `mod.ts` re-exports `Artifact`, `Manifest`, `publishArtifact`, `updateArtifact`,
  `setArtifactTitle`, `removeArtifact`, `loadManifest`, `deriveSlug`, `extractTitle`, `artifactUrl`,
  `renderGallery`.

- [ ] **Step 1: Extend the failing test**

In `src/admin_test.ts`, add one assertion to the existing "import closure" test, after the
`discovery.ts` line:

```ts
assert(!seen.has("artifacts.ts"), "build path must not import artifacts.ts");
```

- [ ] **Step 2: Run test to verify current state**

Run: `deno task test src/admin_test.ts` Expected: PASS already (build.ts does not import
artifacts.ts). This assertion is a **regression guard** — it locks the invariant so a future edit
that routes artifacts through the build path fails loudly. If it FAILS now, a wrongful import was
introduced in an earlier task — fix that import before continuing.

- [ ] **Step 3: Add the exports**

In `src/mod.ts`, append after the comments exports:

```ts
export {
  artifactUrl,
  deriveSlug,
  extractTitle,
  loadManifest,
  publishArtifact,
  removeArtifact,
  renderGallery,
  setArtifactTitle,
  updateArtifact,
} from "./artifacts.ts";
export type { Artifact, Manifest } from "./artifacts.ts";
```

- [ ] **Step 4: Run the full suite**

Run: `deno test --allow-read --allow-write --allow-env` Expected: PASS (all tests, including the
extended purity guard).

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/mod.ts src/admin_test.ts && deno lint src/mod.ts
git add src/mod.ts src/admin_test.ts
git commit -m "feat(artifacts): pin build-purity and export public surface"
```

---

### Task 8: `reading-room artifact` CLI

**Files:**

- Create: `src/artifact-cli.ts`
- Create: `src/artifact-cli_test.ts`
- Modify: `src/cli.ts` (route `artifact` + usage line)

**Interfaces:**

- Consumes: `parseArgs` from `@std/cli@1/parse-args`.
- Produces: `artifactMain(args: string[]): Promise<number>` — subcommands `<path>` (publish),
  `list`, `update <slug> <path>`, `rm <slug>`; talks to `http://127.0.0.1:<port>/api/artifacts`.
  Port: `--port` → `$PORT` → `8413`.

- [ ] **Step 1: Write the failing test**

The network paths need a running server, so unit-test the pure pieces: argument→request mapping and
the port resolver. Factor those into exported pure helpers.

```ts
// src/artifact-cli_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { planRequest, resolvePort } from "./artifact-cli.ts";

Deno.test("resolvePort: flag > $PORT > 8413", () => {
  assertEquals(resolvePort("9000", undefined), 9000);
  assertEquals(resolvePort(undefined, "7000"), 7000);
  assertEquals(resolvePort(undefined, undefined), 8413);
  assertEquals(resolvePort(undefined, "garbage"), 8413);
});

Deno.test("planRequest maps subcommands to method + path + body", () => {
  assertEquals(planRequest(["/abs/x.html"], {}), {
    method: "POST",
    path: "/api/artifacts",
    body: { path: "/abs/x.html" },
  });
  assertEquals(planRequest(["/abs/x.html"], { name: "Foo", title: "Bar" }), {
    method: "POST",
    path: "/api/artifacts",
    body: { path: "/abs/x.html", name: "Foo", title: "Bar" },
  });
  assertEquals(planRequest(["list"], {}), { method: "GET", path: "/api/artifacts" });
  assertEquals(planRequest(["update", "mock", "/abs/y.html"], {}), {
    method: "PUT",
    path: "/api/artifacts/mock",
    body: { path: "/abs/y.html" },
  });
  assertEquals(planRequest(["rm", "mock"], {}), { method: "DELETE", path: "/api/artifacts/mock" });
});

Deno.test("planRequest rejects malformed invocations", () => {
  assertEquals(
    planRequest([], {}),
    "usage: reading-room artifact <path> | list | update <slug> <path> | rm <slug>",
  );
  assertEquals(typeof planRequest(["rm"], {}), "string");
  assertEquals(typeof planRequest(["update", "mock"], {}), "string");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test src/artifact-cli_test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/artifact-cli.ts
/**
 * `reading-room artifact` — publish/list/update/remove artifacts by driving the
 * running server's /api/artifacts routes over 127.0.0.1. The server (not this
 * CLI) reaches the tailnet; the CLI only needs localhost. Port resolves
 * --port → $PORT → 8413 (the agent default).
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { resolve } from "jsr:@std/path@1";

export interface PlannedRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, string>;
}

export function resolvePort(flag: string | undefined, env: string | undefined): number {
  const raw = flag ?? env ?? "8413";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8413;
}

const USAGE = "usage: reading-room artifact <path> | list | update <slug> <path> | rm <slug>";

/** Map argv (sub + rest) and parsed flags to an HTTP request, or a usage string. */
export function planRequest(
  rest: string[],
  flags: { name?: string; title?: string },
): PlannedRequest | string {
  const [a, b, c] = rest;
  if (!a) return USAGE;
  if (a === "list") return { method: "GET", path: "/api/artifacts" };
  if (a === "rm") return b ? { method: "DELETE", path: `/api/artifacts/${b}` } : USAGE;
  if (a === "update") {
    return b && c
      ? { method: "PUT", path: `/api/artifacts/${b}`, body: { path: resolve(c) } }
      : USAGE;
  }
  // default: publish a path
  const body: Record<string, string> = { path: resolve(a) };
  if (flags.name) body.name = flags.name;
  if (flags.title) body.title = flags.title;
  return { method: "POST", path: "/api/artifacts", body };
}

export async function artifactMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["name", "title", "port"] });
  const plan = planRequest(a._.map(String), { name: a.name, title: a.title });
  if (typeof plan === "string") {
    console.error(plan);
    return 1;
  }
  const port = resolvePort(a.port, Deno.env.get("PORT"));
  const url = `http://127.0.0.1:${port}${plan.path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: plan.method,
      headers: plan.body ? { "content-type": "application/json" } : undefined,
      body: plan.body ? JSON.stringify(plan.body) : undefined,
    });
  } catch {
    console.error(
      `reading-room: no running Reading Room agent on :${port} — is it installed? (see agent.sh install)`,
    );
    return 1;
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`reading-room: ${res.status} ${text}`);
    return 1;
  }
  console.log(text);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await artifactMain(Deno.args));
}
```

In `src/cli.ts`, import and route:

```ts
// add import:
import { artifactMain } from "./artifact-cli.ts";
// add case in the switch, after add-doc:
      case "artifact":
        return await artifactMain(rest);
```

And add a usage line under the Commands block in `USAGE`:

```
artifact  <path> | list | update <slug> <p> | rm <slug>   Manage raw-served artifacts
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test src/artifact-cli_test.ts` Expected: PASS.

- [ ] **Step 5: Format, lint, commit**

```bash
deno fmt src/artifact-cli.ts src/artifact-cli_test.ts src/cli.ts && deno lint src/artifact-cli.ts src/cli.ts
git add src/artifact-cli.ts src/artifact-cli_test.ts src/cli.ts
git commit -m "feat(artifacts): reading-room artifact CLI"
```

---

### Task 9: Docs + full-suite green

**Files:**

- Modify: `CLAUDE.md` (engine repo — add an artifact-store section + the serve-only invariant)
- Modify: `README.md` (short feature blurb + CLI usage)
- Test: full suite + fmt + lint

**Interfaces:** none (documentation).

- [ ] **Step 1: Update `CLAUDE.md`**

Add a new section after "Peer discovery (serve-only)":

```markdown
## Artifact store (serve-only)

A persistent, raw-served sibling to the curated library: `reading-room artifact <path>` snapshots an
arbitrary web document or directory into the content home (`artifacts/<slug>/…`, recorded in a
machine-managed `artifacts.json`), and the server exposes it verbatim at `/artifacts/<slug>/` with a
gallery at `/artifacts`. Management rides the localhost `/api/artifacts` routes (READONLY-gated like
`/api/docs`); the tailnet URL is built from `selfDnsName()` (a `tailscale status --json` lookup,
injected in tests). Content is served with **no** editorial/admin transform — it is the bytes that
were snapshotted.

Invariants: (1) serve-only — `build.ts` must never import `src/artifacts.ts` (pinned in
`admin_test.ts` alongside `discovery.ts`); (2) content-home storage, generic engine; (3) no new
permissions (serve's existing `--allow-read`/`--allow-write`/`--allow-run` cover it). See
`_specs/2026-07-04-artifact-store-design.md`.
```

Also, in land mine #7 (the `--allow-run` note), append one sentence: "`src/artifacts.ts` reuses that
same `tailscale` shell-out (via `selfDnsName`) to build artifact URLs — it adds no new external
calls or permissions."

- [ ] **Step 2: Update `README.md`**

Locate the section documenting the `reading-room` subcommands (near `serve`/`add-doc`). Add this
blurb in the matching heading style:

```markdown
### Artifacts

Publish an arbitrary web document or directory over your tailnet without filing it into the curated
library:

    reading-room artifact ./mockup.html        # snapshot + print the tailnet URL
    reading-room artifact ./site --name demo    # a whole directory
    reading-room artifact list
    reading-room artifact update demo ./site    # re-snapshot in place
    reading-room artifact rm demo

Content is served verbatim at `/artifacts/<slug>/` (no editorial chrome) and browsable at
`/artifacts`. Tailnet-only, like the rest of the Reading Room.
```

- [ ] **Step 3: Run the full verification suite**

```bash
deno test --allow-read --allow-write --allow-env
deno fmt --check
deno lint
deno publish --dry-run
```

Expected: all green. `deno publish --dry-run` confirms the package still builds for JSR.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(artifacts): document the artifact store"
```

- [ ] **Step 5: Manual smoke test (record results, do not automate)**

```bash
# From a content home (or `reading-room init` a temp one):
reading-room serve 8413 &
echo '<html><head><title>Smoke</title></head><body>hi</body></html>' > /tmp/smoke.html
reading-room artifact /tmp/smoke.html          # → prints slug + localUrl (+ tailnet url if serve is up)
curl -s http://127.0.0.1:8413/artifacts/smoke/ # → the raw page
curl -s http://127.0.0.1:8413/artifacts        # → gallery lists it
reading-room artifact list
reading-room artifact rm smoke
kill %1
```

Expected: publish prints a URL; the raw page has no `RR-ADMIN`; the gallery lists then drops the
artifact.

---

## Rollout (after the plan is complete — separate from the code commits)

1. Bump `version` in `deno.jsonc`; commit; tag `v<version>`; push the tag (CI publishes to JSR).
2. Per machine: re-run the `deno install -g -f -n reading-room … jsr:@tlockney/reading-room/cli`
   line at the new version (see `CLAUDE.md` → "Installed CLI"), and bump the pinned version in the
   **content repo's** `deno.jsonc` tasks. The launchd agent picks it up on next start.
3. The content-home `reading-room` Claude skill (`~/.claude/skills/reading-room`) lives outside this
   repo; update its "Operations" table to mention `reading-room artifact` in a separate change.

## Notes for the implementer

- The existing `src/serve_test.ts` already builds a `RoomContext` over a temp dir and calls
  `makeHandler` — reuse that harness; the Task 5/6 snippets assume `makeContext`, `makeHandler`, and
  `join` are already imported there (add any that are missing).
- Deno's `serveDir`/`serveFile` set their own `content-type` and handle range requests; do not wrap
  their responses in `page()` (that would corrupt binary/non-HTML artifacts).
- Keep `deno fmt`'s `fmt.exclude` fence intact; none of the new files are excluded, so format them
  normally.
- `deno task test <file>` runs the repo's test task
  (`deno test --allow-read --allow-write
  --allow-env`) scoped to that file — Deno forwards the
  trailing path argument. Use it rather than a bare `deno test <file>`, which would fail on missing
  permissions (temp dirs, env reads).

```
```
