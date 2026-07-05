/**
 * Reading Room — artifact store (serve-only). A persistent, raw-served sibling
 * to the curated library: publish an arbitrary web document or directory, get a
 * durable /artifacts/<slug>/ URL. Content is copied into the content home
 * (artifacts/<slug>/…) and recorded in a machine-managed manifest
 * (artifacts.json). build.ts MUST NOT import this module (serve-only, like
 * discovery.ts; build-purity is pinned in admin_test.ts).
 */
import { writeAtomic } from "./comments.ts";
import { copy, ensureDir, exists, walk } from "jsr:@std/fs@1";
import { basename, join } from "jsr:@std/path@1";

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

/** Remove a path if it exists; ignore only "not found", surface real errors. */
async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

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

  await removeIfExists(dest);
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
  await removeIfExists(join(opts.artifactsDir, opts.slug));
  await saveManifest(opts.manifestPath, keep);
  return true;
}

/** Tailnet URL for an artifact's content root. */
export function artifactUrl(dnsName: string, slug: string): string {
  return `https://${dnsName}/artifacts/${slug}/`;
}

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
