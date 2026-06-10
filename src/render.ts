/**
 * Reading Room — shared rendering core.
 *
 * Pure(ish) functions that turn registry.jsonc + source HTML into the finished
 * index page and per-doc pages. Consumed by BOTH:
 *   - serve.ts  — renders on the fly per request (no build step; edits to the
 *                 registry or a source doc show up on the next refresh)
 *   - build.ts  — writes the same output to static files for remote publish
 *
 * Source documents are never modified.
 */
import { basename, join } from "jsr:@std/path@1";
import { exists } from "jsr:@std/fs@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { escape } from "jsr:@std/html@1";
import type { RoomContext, Site } from "./config.ts";

// Shared zoom + theme + mobile bundle — the single source of truth, also
// inlined verbatim into the editorial-longform-html skill template (a drift
// test pins the two copies together). Embedded at codegen time (deno task gen)
// so the published JSR package never reads package-relative files.
import { EDITORIAL_BODY as BODY_PARTIAL, EDITORIAL_HEAD as HEAD_PARTIAL } from "./assets_gen.ts";

// RR-only chrome (NOT shared with standalone skill docs): the favicon links
// resolve only on the served site, so they never go into a portable doc.
const FAVICON_START = "<!-- EDITORIAL-FAVICON:start -->";
const FAVICON_END = "<!-- EDITORIAL-FAVICON:end -->";
const FAVICON_SNIPPET = FAVICON_START +
  `\n<link rel="icon" type="image/svg+xml" href="/favicon.svg">` +
  `\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n` + FAVICON_END;

export interface Doc {
  slug: string;
  title: string;
  kind: string;
  desc: string;
  footLeft: string;
  footRight: string;
  src: string;
  visibility?: "private" | "shared";
  review?: boolean;
}
export interface Topic {
  num: string;
  id: string;
  name: string;
  short: string;
  docs: Doc[];
}

const e = (s: string): string => escape(s);

export async function loadCorpus(path: string): Promise<Topic[]> {
  return parseJsonc(await Deno.readTextFile(path)) as unknown as Topic[];
}

// --- Back-to-index breadcrumb injected into each doc copy -------------------
const NAV_START = "<!-- READING-ROOM-NAV:start -->";
const NAV_END = "<!-- READING-ROOM-NAV:end -->";

function navSnippet(topicId: string, topicShort: string, docTitle: string): string {
  const short = e(topicShort);
  const title = e(docTitle);
  return `${NAV_START}
<div data-library-nav style="position:sticky;top:0;z-index:60;background:#f3ecdd;border-bottom:1px solid #c9bfa3;">
  <div style="max-width:880px;margin:0 auto;padding:11px clamp(20px,5vw,56px);display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;line-height:1.4;">
    <a href="/" style="color:#a85a1a;text-decoration:none;">&#167; Reading Room</a>
    <span style="color:#8a7e5e;">/</span>
    <a href="/#${topicId}" style="color:#6b6357;text-decoration:none;">${short}</a>
    <span style="color:#8a7e5e;">/</span>
    <span style="color:#6b6357;">${title}</span>
  </div>
</div>
${NAV_END}`;
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BODY_RE = /(<body[^>]*>)/i;
const BODY_END_RE = /<\/body>/i;
const HEAD_END_RE = /<\/head>/i;
const EXISTING_NAV_RE = new RegExp(reEscape(NAV_START) + "[\\s\\S]*?" + reEscape(NAV_END), "g");
const EDITORIAL_HEAD_RE = /<!-- EDITORIAL-HEAD:start -->[\s\S]*?<!-- EDITORIAL-HEAD:end -->\n?/g;
const EDITORIAL_BODY_RE = /<!-- EDITORIAL-BODY:start -->[\s\S]*?<!-- EDITORIAL-BODY:end -->\n?/g;
const EXISTING_FAVICON_RE = new RegExp(
  reEscape(FAVICON_START) + "[\\s\\S]*?" + reEscape(FAVICON_END) + "\\n?",
  "g",
);

// RR-ADMIN: the serve-only management layer's region markers. render.ts only
// STRIPS this region — healing docs saved from a served page (e.g. a curl of
// /docs/<slug> dropped into _migrated/) so the static build can never carry
// management chrome. Injection lives in admin.ts, which serve.ts alone imports.
export const ADMIN_START = "<!-- RR-ADMIN:start -->";
export const ADMIN_END = "<!-- RR-ADMIN:end -->";
const EXISTING_ADMIN_RE = new RegExp(
  reEscape(ADMIN_START) + "[\\s\\S]*?" + reEscape(ADMIN_END) + "\\n?",
  "g",
);

/** Strip any baked-in admin region from a source doc (idempotent). */
export function stripAdmin(docHtml: string): string {
  return docHtml.replace(EXISTING_ADMIN_RE, "");
}

// Per-environment additive slots: a consumer's assets/head-extra.html and
// assets/body-extra.html ride along on every page (index, served docs, static
// builds) in their own marked regions. Additive only — the canonical editorial
// bundle always injects regardless; there is no override mechanism.
export interface LocalSlots {
  head: string;
  body: string;
}

const LOCAL_HEAD_START = "<!-- RR-LOCAL-HEAD:start -->";
const LOCAL_HEAD_END = "<!-- RR-LOCAL-HEAD:end -->";
const LOCAL_BODY_START = "<!-- RR-LOCAL-BODY:start -->";
const LOCAL_BODY_END = "<!-- RR-LOCAL-BODY:end -->";
const EXISTING_LOCAL_HEAD_RE = new RegExp(
  reEscape(LOCAL_HEAD_START) + "[\\s\\S]*?" + reEscape(LOCAL_HEAD_END) + "\\n?",
  "g",
);
const EXISTING_LOCAL_BODY_RE = new RegExp(
  reEscape(LOCAL_BODY_START) + "[\\s\\S]*?" + reEscape(LOCAL_BODY_END) + "\\n?",
  "g",
);

async function readOr(path: string, fallback: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return fallback;
  }
}

/** Read a content root's slot fragments (absent files mean empty slots). */
export async function loadSlots(root: string): Promise<LocalSlots> {
  return {
    head: await readOr(join(root, "assets/head-extra.html"), ""),
    body: await readOr(join(root, "assets/body-extra.html"), ""),
  };
}

/** Strip-then-inject both slot regions (idempotent, healing, empty = absent). */
export function injectLocalSlots(html: string, slots: LocalSlots): string {
  let out = html.replace(EXISTING_LOCAL_HEAD_RE, "").replace(EXISTING_LOCAL_BODY_RE, "");
  if (slots.head && HEAD_END_RE.test(out)) {
    const block = `${LOCAL_HEAD_START}\n${slots.head}\n${LOCAL_HEAD_END}`;
    out = out.replace(HEAD_END_RE, (): string => block + "\n</head>");
  }
  if (slots.body && BODY_END_RE.test(out)) {
    const block = `${LOCAL_BODY_START}\n${slots.body}\n${LOCAL_BODY_END}`;
    out = out.replace(BODY_END_RE, (): string => block + "\n</body>");
  }
  return out;
}

const HREF_RE = /href="([^"]+)"/g;

function sourceBasenameToSlug(corpus: Topic[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of corpus) for (const d of t.docs) m.set(basename(d.src), `/docs/${d.slug}`);
  return m;
}

/** Repoint sibling-document links at their new absolute, extensionless paths. */
function rewriteLinks(docHtml: string, nameToSlug: Map<string, string>): string {
  return docHtml.replace(HREF_RE, (full: string, href: string): string => {
    if (href.includes("://")) return full;
    const hash = href.indexOf("#");
    const path = hash === -1 ? href : href.slice(0, hash);
    const frag = hash === -1 ? "" : href.slice(hash + 1);
    const target = nameToSlug.get(basename(path));
    if (target === undefined) return full;
    return frag ? `href="${target}#${frag}"` : `href="${target}"`;
  });
}

function injectNav(srcHtml: string, snippet: string): string {
  const cleaned = srcHtml.replace(EXISTING_NAV_RE, "");
  if (!BODY_RE.test(cleaned)) throw new Error("no <body> tag found");
  return cleaned.replace(BODY_RE, (m: string): string => m + "\n" + snippet);
}

// The next three injectors strip any prior copy of their region first — whether
// RR injected it on a previous pass or a skill-authored doc baked it in — then
// re-insert the current canonical. So injection is idempotent and the served
// copy is always up to date, healing drift in older docs.

/** RR-only: favicon links (resolve only on the served site). */
function injectFavicon(docHtml: string): string {
  const cleaned = docHtml.replace(EXISTING_FAVICON_RE, "");
  if (HEAD_END_RE.test(cleaned)) {
    return cleaned.replace(HEAD_END_RE, (): string => FAVICON_SNIPPET + "\n</head>");
  }
  return cleaned;
}

/** Shared bundle: zoom CSS + dark theme + mobile fixes + no-flash init. */
function injectEditorialHead(docHtml: string): string {
  const cleaned = docHtml.replace(EDITORIAL_HEAD_RE, "");
  if (HEAD_END_RE.test(cleaned)) {
    return cleaned.replace(HEAD_END_RE, (): string => HEAD_PARTIAL + "\n</head>");
  }
  return cleaned + HEAD_PARTIAL;
}

/** Shared bundle: zoom behavior + theme toggle button + toggle wiring. */
function injectEditorialBody(docHtml: string): string {
  const cleaned = docHtml.replace(EDITORIAL_BODY_RE, "");
  if (BODY_END_RE.test(cleaned)) {
    return cleaned.replace(BODY_END_RE, (): string => BODY_PARTIAL + "\n</body>");
  }
  return cleaned + BODY_PARTIAL;
}

export { injectEditorialBody, injectEditorialHead, injectFavicon };

/** Resolve a doc's source (editorial override in <root>/_migrated/ else the
 * scattered `src`), then inject breadcrumb + favicon + the shared editorial
 * bundle. */
export async function transformDoc(
  ctx: RoomContext,
  corpus: Topic[],
  topic: Topic,
  doc: Doc,
): Promise<string> {
  const override = join(ctx.migratedDir, `${doc.slug}.html`);
  const src = (await exists(override)) ? override : join(ctx.workspace, doc.src);
  if (!(await exists(src))) throw new Error(`missing source: ${src}`);
  const body = rewriteLinks(await Deno.readTextFile(src), sourceBasenameToSlug(corpus));
  const withNav = injectNav(body, navSnippet(topic.id, topic.short, doc.title));
  return injectLocalSlots(
    injectEditorialBody(injectEditorialHead(injectFavicon(stripAdmin(withNav)))),
    await loadSlots(ctx.root),
  );
}

/** Find + render a doc by slug; null if no such slug. */
export async function transformDocBySlug(
  ctx: RoomContext,
  corpus: Topic[],
  slug: string,
): Promise<string | null> {
  for (const t of corpus) {
    for (const d of t.docs) if (d.slug === slug) return await transformDoc(ctx, corpus, t, d);
  }
  return null;
}

// --- Index page -------------------------------------------------------------
function card(d: Doc): string {
  const review = d.review ? `<span class="review">For Review</span>` : "";
  return `      <a class="card" href="/docs/${d.slug}">` + review +
    `<div class="kind">${e(d.kind)}</div>` +
    `<div class="ttl">${e(d.title)}</div>` +
    `<div class="desc">${e(d.desc)}</div>` +
    `<div class="foot"><span>${e(d.footLeft)}</span><span>${e(d.footRight)}</span></div></a>`;
}

function group(t: Topic): string {
  const n = t.docs.length;
  const label = n === 1 ? "document" : "documents";
  const cards = t.docs.map(card).join("\n");
  return `  <div class="group" id="${t.id}">\n` +
    `    <div class="group-head"><span class="num">${t.num}</span>` +
    `<h2>${e(t.name)}</h2><span class="count">${n} ${label}</span></div>\n` +
    `    <div class="grid">\n${cards}\n    </div>\n` +
    `  </div>`;
}

function reviewGroup(docs: Doc[]): string {
  const n = docs.length;
  const label = n === 1 ? "document" : "documents";
  const cards = docs.map(card).join("\n");
  return `  <div class="group review-group" id="for-review">\n` +
    `    <div class="group-head"><span class="num">▸</span>` +
    `<h2>For Review</h2><span class="count">${n} ${label}</span></div>\n` +
    `    <div class="grid">\n${cards}\n    </div>\n` +
    `  </div>`;
}

function chip(t: Topic): string {
  return `    <a href="#${t.id}">${e(t.name)}<span class="c">${t.docs.length}</span></a>`;
}

function minimapItem(t: Topic): string {
  return `  <a href="#${t.id}"><span>${e(t.short)}</span><span class="mn">${
    String(t.docs.length).padStart(2, "0")
  }</span></a>`;
}

export function renderIndex(site: Site, corpus: Topic[]): string {
  const total = corpus.reduce((s, t) => s + t.docs.length, 0);
  const reviewing = corpus.flatMap((t) => t.docs.filter((d) => d.review));
  const reviewChip = reviewing.length
    ? `    <a class="review-chip" href="#for-review">For Review<span class="c">${reviewing.length}</span></a>\n`
    : "";
  const reviewMini = reviewing.length
    ? `  <a class="review-link" href="#for-review"><span>For Review</span><span class="mn">${
      String(reviewing.length).padStart(2, "0")
    }</span></a>\n`
    : "";
  const groups = reviewing.length
    ? reviewGroup(reviewing) + "\n\n" + corpus.map(group).join("\n\n")
    : corpus.map(group).join("\n\n");
  return injectEditorialBody(injectEditorialHead(injectFavicon(
    indexTemplate(site)
      .replaceAll("%%MINIMAP%%", () => reviewMini + corpus.map(minimapItem).join("\n"))
      .replaceAll("%%CHIPS%%", () => reviewChip + corpus.map(chip).join("\n"))
      .replaceAll("%%GROUPS%%", () => groups)
      .replaceAll("%%TOTAL%%", () => String(total))
      .replaceAll("%%TOPICS%%", () => String(corpus.length)),
  )));
}

function indexTemplate(site: Site): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${site.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,300..900,0..100&family=Source+Serif+4:opsz,wght@8..60,300..700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#f3ecdd; --bg-soft:#ece4d2; --bg-code:#e6dcc4;
    --ink:#000; --ink-soft:#3a3a36; --ink-mute:#6b6357;
    --forest:#1f3a32; --forest-deep:#142822;
    --copper:#a85a1a; --copper-soft:#c87a2f;
    --rule:#c9bfa3; --rule-strong:#8a7e5e;
  }
  *{box-sizing:border-box;}
  html{scroll-behavior:smooth;}
  body{
    margin:0; background:var(--bg);
    background-image:
      radial-gradient(closest-side at 10% 6%, rgba(168,90,26,0.06), transparent 70%),
      radial-gradient(closest-side at 92% 98%, rgba(31,58,50,0.06), transparent 70%);
    color:var(--ink);
    font-family:"Source Serif 4",Georgia,serif; font-size:17px; line-height:1.65;
    -webkit-font-smoothing:antialiased;
  }
  .container{max-width:880px;margin:0 auto;padding:80px 56px 120px;}
  .eyebrow{
    font-family:"JetBrains Mono",monospace; font-size:11px; letter-spacing:0.28em;
    text-transform:uppercase; color:var(--copper); margin-bottom:24px;
  }
  h1{
    font-family:"Fraunces",serif; font-variation-settings:"opsz" 144,"SOFT" 50;
    font-weight:400; font-size:60px; line-height:1.02; letter-spacing:-0.02em;
    color:var(--forest-deep); margin:0 0 26px;
  }
  h1 em{font-style:italic;font-variation-settings:"opsz" 144,"SOFT" 100;color:var(--copper);}
  .lede{
    font-family:"Fraunces",serif; font-variation-settings:"opsz" 72;
    font-weight:300; font-style:italic; font-size:22px; line-height:1.45;
    color:var(--ink-soft); max-width:660px; margin:0 0 40px;
  }
  .chips{
    display:flex; flex-wrap:wrap; gap:10px; margin:0 0 56px;
    padding-bottom:28px; border-bottom:1px solid var(--rule);
  }
  .chips a{
    font-family:"JetBrains Mono",monospace; font-size:10px; letter-spacing:0.16em;
    text-transform:uppercase; color:var(--ink-soft); text-decoration:none;
    padding:7px 14px; border:1px solid var(--rule-strong); border-radius:2px;
    transition:color .18s,border-color .18s;
  }
  .chips a:hover{color:var(--copper);border-color:var(--copper);}
  .chips a .c{color:var(--ink-mute);margin-left:7px;}
  .group{margin:0 0 56px;}
  .group-head{
    display:flex; align-items:baseline; gap:16px; margin:0 0 24px;
    padding-bottom:10px; border-bottom:1.5px solid var(--rule-strong);
  }
  .group-head .num{
    font-family:"JetBrains Mono",monospace; font-size:12px; font-weight:600;
    letter-spacing:0.14em; color:var(--copper);
  }
  .group-head h2{
    font-family:"Fraunces",serif; font-variation-settings:"opsz" 60,"SOFT" 40;
    font-weight:400; font-size:27px; color:var(--forest-deep); margin:0;
    letter-spacing:-0.01em;
  }
  .group-head .count{
    margin-left:auto; font-family:"JetBrains Mono",monospace; font-size:10px;
    letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-mute);
  }
  .grid{display:grid; gap:18px; grid-template-columns:repeat(auto-fill,minmax(300px,1fr));}
  .card{
    border:1px solid var(--rule); background:var(--bg-soft);
    padding:22px 22px 20px; text-decoration:none; color:inherit;
    display:flex; flex-direction:column; min-height:150px; transition:border-color .18s;
  }
  .card:hover{border-color:var(--copper);}
  .card .kind{
    font-family:"JetBrains Mono",monospace; font-size:9.5px; letter-spacing:0.2em;
    text-transform:uppercase; color:var(--copper); margin-bottom:12px;
  }
  .card .ttl{
    font-family:"Fraunces",serif; font-variation-settings:"opsz" 36;
    font-size:20px; line-height:1.2; color:var(--ink); transition:color .18s;
  }
  .card:hover .ttl{color:var(--copper);}
  .card .desc{font-size:14px; line-height:1.5; color:var(--ink-soft); font-style:italic; margin-top:10px;}
  .card .foot{
    margin-top:auto; padding-top:14px; font-family:"JetBrains Mono",monospace;
    font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase;
    color:var(--ink-mute); display:flex; justify-content:space-between; gap:10px;
  }
  .card{position:relative;}
  .card .review{
    position:absolute; top:14px; right:14px;
    font-family:"JetBrains Mono",monospace; font-size:8.5px; letter-spacing:0.16em;
    text-transform:uppercase; color:var(--copper);
    border:1px solid var(--copper); border-radius:2px; padding:2px 6px;
    background:rgba(168,90,26,0.07);
  }
  .review-group .group-head{border-bottom-color:var(--copper);}
  .chips a.review-chip{color:var(--copper);border-color:var(--copper);}
  .minimap{display:none;}
  @media(min-width:1180px){
    .chips{display:none;}
    .minimap{
      display:block; position:fixed; top:120px;
      left:max(20px,calc(50vw - 580px)); width:150px; z-index:5;
      font-family:"JetBrains Mono",monospace; font-size:9px; letter-spacing:0.1em;
      line-height:1.5; color:var(--ink-soft);
    }
    .minimap .minimap-label{color:var(--copper);margin-bottom:10px;letter-spacing:0.18em;}
    .minimap a{
      display:flex; justify-content:space-between; gap:6px;
      padding:5px 8px 5px 12px; color:var(--ink-soft); text-decoration:none;
      border-left:2px solid var(--rule); text-transform:uppercase;
    }
    .minimap a .mn{color:var(--ink-mute);}
    .minimap a:hover{color:var(--copper);border-left-color:var(--copper);}
  }
  footer{
    margin-top:80px; padding-top:20px; border-top:1px solid var(--rule);
    display:flex; justify-content:space-between; flex-wrap:wrap; gap:12px;
    font-family:"JetBrains Mono",monospace; font-size:10px; letter-spacing:0.16em;
    text-transform:uppercase; color:var(--ink-mute);
  }
  @media(max-width:720px){
    .container{padding:48px 24px 80px;}
    h1{font-size:42px;}
    .grid{grid-template-columns:1fr;}
  }
</style>
</head>
<body>
<nav class="minimap" aria-label="Topics">
  <div class="minimap-label">§ Topics</div>
%%MINIMAP%%
</nav>

<div class="container">
  <div class="eyebrow">${site.eyebrow}</div>
  <h1>The Reading <em>Room</em></h1>
  <p class="lede">${site.lede}</p>

  <nav class="chips" aria-label="Topics">
%%CHIPS%%
  </nav>

%%GROUPS%%

  <footer>
${site.footer.map((s) => `    <span>${s}</span>`).join("\n")}
  </footer>
</div>
</body>
</html>
`;
}
