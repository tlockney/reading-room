#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env=PORT
/**
 * Serve the Reading Room locally — rendered DYNAMICALLY per request, no build
 * step. Binds 127.0.0.1 ONLY; expose it over your tailnet (HTTPS, tailnet-only)
 * with `tailscale serve`. Editing registry.jsonc or any source doc shows up on
 * the next refresh; new documents appear without restarting.
 *
 *   deno task serve            # 127.0.0.1:8413
 *   PORT=9000 deno task serve  # or:  deno task serve 9000
 *
 * (Run under launchd via ./agent.sh install for an always-on local agent.)
 */
import { loadCorpus, REGISTRY, renderIndex, ROOT, transformDocBySlug } from "./render.ts";
import { join } from "jsr:@std/path@1";

const port = Number(Deno.args[0] ?? Deno.env.get("PORT") ?? 8413);
const DOC_RE = /^\/docs\/([A-Za-z0-9_-]+)\/?$/; // canonical: /docs/<slug> (S3 also serves /docs/<slug>/)
const DOC_HTML_RE = /^\/docs\/([A-Za-z0-9._-]+)\.html$/; // legacy: redirect to extensionless

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
async function asset(name: string, type: string): Promise<Response> {
  try {
    return new Response(await Deno.readFile(join(ROOT, name)), {
      headers: { "content-type": type, "cache-control": "max-age=3600" },
    });
  } catch {
    return notice("Not found.", 404);
  }
}

async function handler(req: Request): Promise<Response> {
  const path = decodeURIComponent(new URL(req.url).pathname);
  if (path === "/favicon.svg") return asset("favicon.svg", "image/svg+xml");
  if (path === "/apple-touch-icon.png") return asset("apple-touch-icon.png", "image/png");
  if (path === "/index.html") return redirect("/");
  const legacy = path.match(DOC_HTML_RE);
  if (legacy) return redirect(`/docs/${legacy[1]}`);
  try {
    const corpus = await loadCorpus(); // re-read per request → no restart needed
    if (path === "/") return page(renderIndex(corpus));
    const m = path.match(DOC_RE);
    if (m) {
      const doc = await transformDocBySlug(corpus, m[1]);
      return doc ? page(doc) : notice(`No such document: <b>${esc(m[1])}</b>`, 404);
    }
    return notice("Not found.", 404);
  } catch (err) {
    return notice(`Render error:<br><br>${esc(String(err))}`, 500);
  }
}

console.log(`\n  Reading Room — rendered live on http://127.0.0.1:${port}/ (localhost only).`);
console.log(`  Expose over your tailnet (HTTPS):  tailscale serve --bg ${port}`);
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
