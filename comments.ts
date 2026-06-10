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
  reviewed?: string; // ISO-8601 — when it was marked reviewed; absent = active
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
  const comment: Comment = {
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    quote: input.quote,
    prefix: input.prefix,
    suffix: input.suffix,
    note: input.note,
  };
  all.push(comment);
  await writeAtomic(fileFor(dir, slug), JSON.stringify(all, null, 2) + "\n");
  return comment;
}

/** Stamp or clear the reviewed marker on one comment; null when the id is
 * unknown. Clearing removes the key (absent and unreviewed are the same),
 * mirroring how registry-edit treats `review: false`. */
export async function setCommentReviewed(
  dir: string,
  slug: string,
  id: string,
  reviewed: boolean,
): Promise<Comment | null> {
  const all = await loadComments(dir, slug);
  const target = all.find((c) => c.id === id);
  if (!target) return null;
  if (reviewed) target.reviewed = new Date().toISOString();
  else delete target.reviewed;
  await writeAtomic(fileFor(dir, slug), JSON.stringify(all, null, 2) + "\n");
  return target;
}

export async function deleteComment(dir: string, slug: string, id: string): Promise<boolean> {
  const all = await loadComments(dir, slug);
  const keep = all.filter((c) => c.id !== id);
  if (keep.length === all.length) return false;
  await writeAtomic(fileFor(dir, slug), JSON.stringify(keep, null, 2) + "\n");
  return true;
}
