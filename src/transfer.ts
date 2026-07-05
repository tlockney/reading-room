/**
 * Reading Room — peer-to-peer document transfer (serve-only). Send a curated
 * library doc to another Reading Room instance over the tailnet-exposed server
 * APIs: buildDocPayload assembles { html, meta, comments? }; sendDoc POSTs it to
 * a peer's /api/receive; receiveDoc files an incoming payload review:true into a
 * "Received" topic. No Taildrop, no shell-out. build.ts MUST NOT import this
 * module (serve-only, like discovery.ts; pinned in admin_test.ts).
 */
import { exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { resolveInstanceName } from "./config.ts";
import type { RoomContext } from "./config.ts";
import type { Doc, Topic } from "./render.ts";
import { loadComments } from "./comments.ts";
import type { Comment } from "./comments.ts";

export interface DocMeta {
  slug: string;
  title: string;
  kind: string;
  desc: string;
  footLeft: string;
  footRight: string;
  originTopic: string; // the sender's topic id — advisory, for the user re-filing
  visibility: "private" | "shared";
  origin: string; // sender instance name
}

export interface DocPayload {
  html: string;
  meta: DocMeta;
  comments?: Comment[];
}

function findDoc(corpus: Topic[], slug: string): { topic: Topic; doc: Doc } | null {
  for (const topic of corpus) {
    for (const doc of topic.docs) if (doc.slug === slug) return { topic, doc };
  }
  return null;
}

export async function buildDocPayload(
  ctx: RoomContext,
  corpus: Topic[],
  slug: string,
  opts: { withComments?: boolean },
): Promise<DocPayload> {
  const found = findDoc(corpus, slug);
  if (!found) throw new Error(`unknown slug: ${slug}`);
  const override = join(ctx.migratedDir, `${slug}.html`);
  const html = await exists(override)
    ? await Deno.readTextFile(override)
    : await Deno.readTextFile(join(ctx.workspace, found.doc.src));
  const payload: DocPayload = {
    html,
    meta: {
      slug: found.doc.slug,
      title: found.doc.title,
      kind: found.doc.kind,
      desc: found.doc.desc,
      footLeft: found.doc.footLeft,
      footRight: found.doc.footRight,
      originTopic: found.topic.id,
      visibility: found.doc.visibility ?? "private",
      origin: resolveInstanceName(ctx.site),
    },
  };
  if (opts.withComments) {
    const comments = await loadComments(ctx.commentsDir, slug);
    if (comments.length) payload.comments = comments;
  }
  return payload;
}

function parseMeta(raw: unknown): DocMeta | string {
  if (typeof raw !== "object" || raw === null) return "meta must be an object";
  const o = raw as Record<string, unknown>;
  for (
    const k of [
      "slug",
      "title",
      "kind",
      "desc",
      "footLeft",
      "footRight",
      "originTopic",
      "origin",
    ] as const
  ) {
    if (typeof o[k] !== "string") return `meta.${k} must be a string`;
  }
  if (o.visibility !== "private" && o.visibility !== "shared") {
    return 'meta.visibility must be "private" or "shared"';
  }
  return {
    slug: o.slug as string,
    title: o.title as string,
    kind: o.kind as string,
    desc: o.desc as string,
    footLeft: o.footLeft as string,
    footRight: o.footRight as string,
    originTopic: o.originTopic as string,
    visibility: o.visibility,
    origin: o.origin as string,
  };
}

export function parseReceivedPayload(raw: unknown): DocPayload | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const o = raw as Record<string, unknown>;
  if (typeof o.html !== "string") return "html must be a string";
  const meta = parseMeta(o.meta);
  if (typeof meta === "string") return meta;
  const payload: DocPayload = { html: o.html, meta };
  if (o.comments !== undefined) {
    if (!Array.isArray(o.comments)) return "comments must be an array";
    payload.comments = o.comments as Comment[];
  }
  return payload;
}
