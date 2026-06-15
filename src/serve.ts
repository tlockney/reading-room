#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-run --allow-sys=hostname --allow-env=PORT,READONLY
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
import { injectLocalSlots, loadCorpus, loadSlots, renderIndex, transformDoc } from "./render.ts";
import type { Doc, Topic } from "./render.ts";
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { makeContext, resolveHome, resolveInstanceName } from "./config.ts";
import type { RoomContext } from "./config.ts";
import { removeDoc, setDocField, slugExists, UnknownSlugError } from "./registry-edit.ts";
import type { DocPatch } from "./registry-edit.ts";
import {
  addComment,
  deleteComment,
  loadComments,
  parseCommentInput,
  setCommentReviewed,
  writeAtomic,
} from "./comments.ts";
import { injectAdmin } from "./admin.ts";
import type { AdminContext } from "./admin.ts";
import { ADMIN_ASSETS, APPLE_TOUCH_ICON_B64, FAVICON_SVG } from "./assets_gen.ts";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";
import { buildIdentity, listTailscalePeers, makeCachedDiscover, probePeer } from "./discovery.ts";
import type { Peer } from "./discovery.ts";
import { VERSION } from "./version.ts";

const APPLE_TOUCH_ICON = decodeBase64(APPLE_TOUCH_ICON_B64);

const DOC_RE = /^\/docs\/([A-Za-z0-9_-]+)\/?$/; // canonical: /docs/<slug> (S3 also serves /docs/<slug>/)
const DOC_HTML_RE = /^\/docs\/([A-Za-z0-9._-]+)\.html$/; // legacy: redirect to extensionless
const API_DOC_RE = /^\/api\/docs\/([A-Za-z0-9_-]+)$/;
const API_COMMENTS_RE = /^\/api\/docs\/([A-Za-z0-9_-]+)\/comments$/;
const API_COMMENT_RE = /^\/api\/docs\/([A-Za-z0-9_-]+)\/comments\/([A-Za-z0-9-]+)$/;
const ADMIN_ASSET_RE = /^\/assets\/admin\/([A-Za-z0-9_-]+\.(?:js|css))$/;

export interface ServeOptions {
  ctx: RoomContext;
  readonly: boolean;
  discover?: () => Promise<Peer[]>;
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
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}
function asset(body: string | Uint8Array<ArrayBuffer>, type: string): Response {
  return new Response(body, {
    headers: { "content-type": type, "cache-control": "max-age=3600" },
  });
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

const NOT_JSON = Symbol("not json");

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return NOT_JSON;
  }
}

async function api(req: Request, path: string, opts: ServeOptions): Promise<Response> {
  if (opts.readonly && req.method !== "GET") return jsonError("read-only mode", 403);
  try {
    if (path === "/api/peers") {
      if (req.method !== "GET") return jsonError("method not allowed", 405);
      try {
        return json({ peers: opts.discover ? await opts.discover() : [] });
      } catch {
        return json({ peers: [] }); // discovery is best-effort — never fail the nav request
      }
    }
    const doc = path.match(API_DOC_RE);
    if (doc) {
      const slug = doc[1];
      if (req.method === "PATCH") {
        const raw = await readJson(req);
        if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
        const patch = parsePatch(raw);
        if (typeof patch === "string") return jsonError(patch, 400);
        const registry = await Deno.readTextFile(opts.ctx.registryPath);
        await writeAtomic(opts.ctx.registryPath, setDocField(registry, slug, patch));
        return json({ ok: true, slug, ...patch });
      }
      if (req.method === "DELETE") {
        const registry = await Deno.readTextFile(opts.ctx.registryPath);
        await writeAtomic(opts.ctx.registryPath, removeDoc(registry, slug));
        return json({
          ok: true,
          removed: slug,
          note:
            "registry entry removed; the _migrated copy and comments sidecar (if any) are left on disk",
        });
      }
      return jsonError("method not allowed", 405);
    }

    const comments = path.match(API_COMMENTS_RE);
    if (comments) {
      const slug = comments[1];
      if (req.method === "GET") return json(await loadComments(opts.ctx.commentsDir, slug));
      if (req.method === "POST") {
        const registry = await Deno.readTextFile(opts.ctx.registryPath);
        if (!slugExists(registry, slug)) return jsonError(`unknown slug: ${slug}`, 404);
        const raw = await readJson(req);
        if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
        const input = parseCommentInput(raw);
        if (typeof input === "string") return jsonError(input, 400);
        return json(await addComment(opts.ctx.commentsDir, slug, input), 201);
      }
      return jsonError("method not allowed", 405);
    }

    const comment = path.match(API_COMMENT_RE);
    if (comment) {
      if (req.method === "PATCH") {
        const raw = await readJson(req);
        if (raw === NOT_JSON) return jsonError("body must be JSON", 400);
        const o = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
        if (!o || typeof o.reviewed !== "boolean" || Object.keys(o).length !== 1) {
          return jsonError('body must be {"reviewed": boolean}', 400);
        }
        const updated = await setCommentReviewed(
          opts.ctx.commentsDir,
          comment[1],
          comment[2],
          o.reviewed,
        );
        return updated ? json(updated) : jsonError("no such comment", 404);
      }
      if (req.method === "DELETE") {
        const ok = await deleteComment(opts.ctx.commentsDir, comment[1], comment[2]);
        return ok ? json({ ok: true }) : jsonError("no such comment", 404);
      }
      return jsonError("method not allowed", 405);
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
    const rawPath = new URL(req.url).pathname;
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return rawPath.startsWith("/api/")
        ? jsonError("malformed path encoding", 400)
        : notice("Bad request.", 400);
    }
    if (path === "/favicon.svg") return asset(FAVICON_SVG, "image/svg+xml");
    if (path === "/apple-touch-icon.png") return asset(APPLE_TOUCH_ICON, "image/png");
    const adminAsset = path.match(ADMIN_ASSET_RE);
    if (adminAsset) {
      const body = ADMIN_ASSETS[adminAsset[1]];
      if (body === undefined) return notice("Not found.", 404);
      const type = adminAsset[1].endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
      return new Response(body, {
        headers: { "content-type": type, "cache-control": "no-cache" },
      });
    }
    if (path === "/.well-known/reading-room.json") {
      if (req.method !== "GET") return jsonError("method not allowed", 405);
      try {
        const corpus = await loadCorpus(opts.ctx.registryPath);
        return json(buildIdentity(resolveInstanceName(opts.ctx.site), corpus, VERSION));
      } catch (err) {
        return jsonError(String(err), 500);
      }
    }
    if (path === "/index.html") return redirect("/");
    const legacy = path.match(DOC_HTML_RE);
    if (legacy) return redirect(`/docs/${legacy[1]}`);
    if (path.startsWith("/api/")) return api(req, path, opts);
    try {
      const corpus = await loadCorpus(opts.ctx.registryPath); // re-read per request → no restart needed
      if (path === "/") {
        const docs: Record<string, { review: boolean; visibility: "private" | "shared" }> = {};
        for (const t of corpus) {
          for (const d of t.docs) {
            docs[d.slug] = { review: d.review === true, visibility: d.visibility ?? "private" };
          }
        }
        const ctx: AdminContext = { page: "index", readonly: opts.readonly, docs };
        const index = injectLocalSlots(
          renderIndex(opts.ctx.site, corpus, resolveInstanceName(opts.ctx.site)),
          await loadSlots(opts.ctx.root),
        );
        return page(injectAdmin(index, ctx));
      }
      const m = path.match(DOC_RE);
      if (m) {
        const found = findDoc(corpus, m[1]);
        if (!found) return notice(`No such document: <b>${esc(m[1])}</b>`, 404);
        const html = await transformDoc(opts.ctx, corpus, found.topic, found.doc);
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
      }
      return notice("Not found.", 404);
    } catch (err) {
      return notice(`Render error:<br><br>${esc(String(err))}`, 500);
    }
  };
}

// --- startup (only when run directly) ----------------------------------------

export async function serveMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["root", "port"] });
  const portArg = a.port ?? a._[0] ?? Deno.env.get("PORT") ?? 8413;
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`reading-room serve: invalid port: ${portArg}`);
    return 1;
  }
  const readonly = Deno.env.get("READONLY") === "1";
  const ctx = await makeContext(resolveHome(a.root));
  const discover = makeCachedDiscover({
    listPeers: () => listTailscalePeers(),
    probe: (url) => probePeer(url),
    seeds: ctx.site.seeds,
  });
  const handler = makeHandler({ ctx, readonly, discover });

  console.log(`\n  Reading Room — rendered live on http://127.0.0.1:${port}/ (localhost only).`);
  console.log(`  Expose over your tailnet (HTTPS):  tailscale serve --bg ${port}`);
  if (readonly) console.log("  READONLY=1 — management routes disabled (view-only).");
  console.log(
    "  Edits to registry.jsonc / source docs show on refresh — no restart. Ctrl-C to stop.\n",
  );

  // Watch the registry for console feedback; freshness comes from the per-request re-read.
  (async () => {
    try {
      for await (const ev of Deno.watchFs(ctx.registryPath)) {
        if (ev.kind === "modify" || ev.kind === "create") {
          console.log("  ↻ registry.jsonc changed — reflected on next request");
        }
      }
    } catch { /* watch unavailable */ }
  })();

  const server = Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, handler);
  await server.finished;
  return 0;
}

if (import.meta.main) {
  Deno.exit(await serveMain(Deno.args));
}
