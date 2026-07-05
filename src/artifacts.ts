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
