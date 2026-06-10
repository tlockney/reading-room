---
name: editorial-longform-html
description: Author long-form reference documents as standalone HTML in the editorial-print aesthetic — ecru paper background, Fraunces display + Source Serif body + JetBrains Mono labels, forest/copper accents, numbered sections, mono eyebrows. The style leans technical but is not engineering-only — use it for any substantive long-form internal document that wants the gravitas of a published handbook: architecture writeups, library/framework guides, system internals, postmortems, design records, RFCs, runbooks, ADRs AND product strategy memos, product requirements / PRDs, roadmap rationale, process playbooks, operational handbooks, policy or governance documents, retrospectives, org-design proposals, vendor evaluations, and similar. Use both when converting from markdown AND when authoring HTML directly to take advantage of inline SVG diagrams, hand-drawn topology figures, interactive Mermaid, hover states, side-by-side code/diagram layouts, or any visual technique that markdown can't express. Trigger on phrases like "make an HTML version", "render this as a doc", "publish this writeup", "convert to HTML", "write this directly in HTML", "reference doc", "playbook", "handbook page", "a doc with diagrams", or whenever the user supplies substantive technical/product/process content and asks for a polished HTML output — assume this style is the default for that class of document unless the user names a different one. Do NOT use for customer-facing marketing pages, status dashboards, quick READMEs, ephemeral status updates, or anything where the editorial tone would feel wrong.
---

# Editorial long-form HTML

A house style for substantive long-form documents.
Editorial-print feel: cream paper, forest + copper accents, three
typefaces, mono eyebrows, numbered sections. Originally captured for
engineering reference docs, but the register — calm, considered,
print-handbook — fits any document where a reader is expected to *sit
with* the content: technical references, but equally product strategy,
PRDs, process playbooks, policy docs, postmortems, retrospectives. The
bundled template and `references/design-language.md` are the canonical
definition of the visual language — don't reinvent it, follow it.

## Scope — what kinds of docs

The style is medium-agnostic about subject matter as long as the
*shape* of the document matches: long-form, sectioned, intended to be
read carefully and referred back to. Some categories that fit
naturally:

- **Technical / engineering** — architecture writeups, library guides,
  system internals, postmortems, RFCs, ADRs, runbooks.
- **Product** — PRDs, strategy memos, roadmap rationale, market
  analyses, competitive landscapes, vendor evaluations.
- **Process / operational** — playbooks, operational handbooks,
  policy and governance docs, org-design proposals, hiring rubrics,
  on-call manuals.
- **Reflective** — retrospectives, decision logs, narrative
  postmortems for non-technical incidents.

When in doubt: if it could plausibly live in a printed company
handbook a year from now, this style fits. If it's ephemeral (status
updates, daily standups, customer-facing copy, marketing), pick
something else.

## The two files you need

- **`assets/engineering-reference.html`** — drop-in template. Start
  every new document by copying this file. It already has the Google
  Fonts link, the CSS variables, every component style, the optional
  Mermaid block, the responsive + print rules, and TODO markers
  showing where content goes.
- **`references/design-language.md`** — the full style guide. Read it
  when you need to decide *which* component to reach for or what a
  specific class is supposed to look like. Don't read it just to fill
  in TODOs — only when a design decision is in front of you.

The zoom + theme + mobile bundle inside the template (the
`EDITORIAL-HEAD` / `EDITORIAL-BODY` blocks) is the **canonical copy
from the Reading Room repo's `assets/editorial/{head,body}.html`**,
inlined here so standalone docs are self-contained. A drift test in
that repo keeps the two in sync — when changing zoom/theme behavior,
edit the partials there and re-sync this template, don't fork it here.

## Two authoring modes

This skill supports two distinct workflows. Pick the one that matches
intent before you start — they share the same visual language but
imply different planning.

- **Markdown → HTML.** The source of truth is a `.md` file; the HTML
  is a published rendering. Keep the HTML structure close to what
  pandoc or a converter would produce so the two stay in sync.
- **HTML-native authoring.** HTML is the medium and the artifact. Use
  this when the document genuinely needs visual capabilities markdown
  can't express: hand-authored SVG topology diagrams, inline Mermaid,
  multi-column layouts, side-by-side code + diagram callouts, custom
  figures, hover-revealed detail, or sequence diagrams that should
  live next to the prose explaining them. Don't pretend a markdown
  source exists — write the HTML directly and let the visual
  affordances drive the structure.

If a document starts in markdown and outgrows it (you keep wanting to
reach for something the format can't do), promote it to HTML-native
rather than papering over with embedded `<div>`s in the `.md`.

## How to use it

1. **Copy `assets/engineering-reference.html` to the target path.** Don't
   write HTML from scratch — the template's CSS is the design, and
   re-deriving it loses fidelity. This applies to both modes.
2. **Search for `TODO` markers** and fill them in: title, eyebrow text,
   h1 (with one italicized word for the copper accent), lede paragraph,
   TOC entries, sections, footer.
3. **Replace numbered `§ 01 / § 02 / …`** for reference docs, or
   `Step / 01 / Step / 02 / …` for how-to docs. Don't mix the two
   modes in one doc.
4. **Keep section h2s wrapped in `<a href="#id" class="heading-link">`.**
   Self-anchoring headings let a reader click any heading and copy the
   section's URL from the address bar — they're a small interaction win
   and the template ships with them wired up. Don't strip the wrap.
5. **Sync the mini-map with the main TOC.** The floating `<nav class="minimap">`
   block is a persistent companion to the main TOC, shown only at viewport
   ≥ 1180px. Its entries must mirror the main TOC for the same document;
   if you add or remove a section, update both. Delete the block (not just
   the CSS) if you don't want a floating nav.
6. **One drop cap per document.** Apply `.lead-para` to the first
   paragraph of the opening section only.
7. **Delete optional blocks you aren't using.** The template ships with
   commented-out scaffolds for the restricted banner, series-nav, and
   figure.diagram. Uncomment what you need; delete the rest so the
   markup stays tidy.
8. **Delete the Mermaid `<script>` block if you're not using diagrams.**
   Don't ship an unused 80KB import.
9. **Keep the container max-width as shipped** (880px for reference,
   820px for how-tos) — the editorial measure is part of the feel.

## Component cheat sheet

| Need | Reach for |
|---|---|
| Document title (clickable) | `<h1><a href="#" class="title-link">Title with <em>accent</em></a></h1>` |
| Section opener (clickable) | `<h2><a href="#id" class="heading-link"><span class="num">§ 04</span>Title</a></h2>` |
| How-to step | `<h2><a href="#id" class="heading-link"><span class="kind">Step / 03</span>Title</a></h2>` |
| Aside / by-the-way | `<div class="note">` |
| Manual / TODO step | `<div class="note warn">` |
| Hard constraint | `<div class="note caveat">` |
| Success state | `<div class="note good">` |
| Pull quote / TL;DR | `<div class="tldr">` |
| Long-section break | `<div class="ornament">§ § §</div>` |
| Inline figure + caption | `<figure class="diagram"><svg…/><figcaption>…</figcaption></figure>` |
| Click-to-zoom figure | automatic — any `<figure>`, `.mermaid`, or `<img>` is made zoomable by the bundled `edzoom` script (click, scroll/±, drag, pinch) |
| Dark-mode toggle | automatic — the bundled theme toggle (bottom-right) flips light/espresso and persists |
| Floating mini-map nav | `<nav class="minimap"><div class="minimap-label">…</div><ol>…</ol></nav>` |
| Multi-part series nav | `<nav class="series-nav"><span class="series-label">…</span><ol>…</ol></nav>` |
| Internal-only banner | `<div class="restricted-banner">Internal · Scope · Not for Distribution</div>` |

Note labels are mono uppercase with an issue-tracker reference where
relevant: `<span class="note-label">Caveat · PROJ-123</span>`. Don't
auto-link those — write the `<a href>` by hand.

## Navigation aids

Three patterns make a long-form doc browsable, all included in the
template by default:

- **Clickable document title** — the `<h1>` wraps its content in
  `<a href="#" class="title-link">`. Clicking the title resets the
  URL hash to empty, so the canonical document URL ends up in the
  address bar even if the reader had navigated to a section anchor.
  Hover turns copper; the italic accent shifts to copper-soft to stay
  visible. No JavaScript.
- **Self-anchoring section headings** — every section `<h2>` wraps its
  content in `<a href="#section-id" class="heading-link">`. Clicking
  the heading sets the URL hash to that section; copy the URL from
  the address bar. Hover state turns copper. No JavaScript.
- **Floating mini-map TOC** — a fixed-position `<nav class="minimap">`
  in the left gutter, shown only at viewport widths ≥ 1180px. Entries
  mirror the main TOC. On browsers that support `animation-timeline:
  scroll()` (Chrome 115+, Safari TP, Firefox via flag), the mini-map
  fades in after the user scrolls past the masthead; everywhere else
  it's always visible at wide widths. The progressive enhancement is
  wrapped in `@supports` so there's no JavaScript fallback to write.

If a document has a per-entry reference structure (catalog of items,
classification reference, list of named entries with type tags), give
each entry an id (e.g. `id="entry-name-slug"`) and wrap the entry
heading in the same `heading-link` pattern — every entry row becomes
individually shareable.

## The editorial bundle (zoom + theme)

The template ships a small shared bundle — figure zoom, a light/dark
theme toggle, and mobile overflow fixes — inlined as two marked blocks:
`EDITORIAL-HEAD` (before `</head>`: CSS + a no-flash theme init) and
`EDITORIAL-BODY` (before `</body>`: the zoom + toggle scripts). It's
included by default and needs no per-figure or per-page markup.

**Figure zoom.**

- **What's zoomable.** Any `<figure>`, any `.mermaid` block, and any
  standalone `<img>` that contains an `svg`/`img`/`canvas`. A faint mono
  "Click to zoom" hint appears on hover; the cursor turns to `zoom-in`.
- **Interaction.** Click to open; scroll or the `+` / `−` buttons to
  zoom; drag to pan; **pinch and two-finger pan on touch devices**;
  double-click to toggle; `Esc`, `Close`, or a backdrop click to
  dismiss. The wheel step is proportional to scroll distance so
  trackpads don't zoom too fast.
- **Register.** In light mode the lightbox uses an ecru backdrop, a mono
  copper control bar, and no icons. The stage fills the viewport so
  zoomed-in wide diagrams pan freely without clipping. A
  `MutationObserver` re-scans the page, so asynchronously-rendered
  Mermaid diagrams become zoomable once drawn.

**Theme toggle.**

- A small mono toggle sits bottom-right. It flips between the light
  editorial palette and a warm **espresso dark** palette (not a generic
  inverted theme — same forest/copper language, and diagrams sit on an
  ecru "plate" so they read as intentional light figures). The choice
  persists in `localStorage`; first load honors `prefers-color-scheme`.
  A no-flash init in `<head>` sets the theme before paint.

**These are the only scripts.** Everything else in this style is static
HTML/CSS. Both pieces are no-ops when unused. To remove the bundle,
delete the `EDITORIAL-HEAD` and `EDITORIAL-BODY` blocks.

## Design rules worth restating

- **Copper is the only accent.** Don't introduce teal, red, blue. If
  you find yourself wanting a second accent color, the answer is to
  use copper more deliberately, not to add one.
- **No icons.** The mono `§` markers and section numbers are the
  iconography. Adding emoji or icon fonts breaks the register.
- **No drop shadows; light by default with an optional dark toggle.**
  This is print, not Material — no shadows, no glow. The bundled theme
  toggle adds a warm espresso dark mode in the same forest/copper
  language (diagrams sit on an ecru plate in dark). The toggle is the
  sanctioned mechanism — don't hand-roll per-element dark hacks.
- **No animations, with one carved-out exception.** The mini-map's
  scroll-triggered fade-in (via `animation-timeline: scroll()`) is
  allowed because it's a navigation aid, progressive-enhancement only,
  and replaces nothing — browsers without support show the same nav
  always-visible. Don't extrapolate from this to decorative motion,
  hover animations, or transitions on content elements. Static
  editorial layouts everywhere else.
- **Two sanctioned scripts — the figure-zoom lightbox and the theme
  toggle.** Aside from the editorial bundle, the style is no-JS:
  navigation aids (title self-link, heading links, mini-map fade) are
  pure HTML/CSS. Zoom and theme are allowed because they're readability
  aids, fully self-contained, and no-ops when unused. Don't take them as
  license to add other scripts, client-side state, or motion — if you
  want interactivity beyond opening a figure or flipping the theme, this
  is the wrong style.
- **Don't use Inter, Roboto, or system-ui.** The whole point is that
  it isn't generic.
- **Dark mode comes from the toggle, not a raw media query.** The
  bundle's no-flash init reads `prefers-color-scheme` as the first-load
  default, then honors the user's saved choice. Don't add your own
  `@media (prefers-color-scheme: dark)` block — drive everything through
  the `:root[data-theme="dark"]` variables the bundle already defines.

If you find yourself wanting to deviate, read
`references/design-language.md` first — the existing tokens probably
already cover the case, and the anti-patterns section calls out the
common temptations.

## Targeting the Reading Room

Docs authored with this skill are standalone — they carry the full
editorial bundle and open correctly off-disk or over email. They can
*also* join the **Reading Room**, the local doc-library this skill
ships alongside (the repository containing this skill directory). The
doc itself doesn't change: the Reading Room's `render.ts` strips the
baked-in `EDITORIAL-*` regions and re-injects the library's current
bundle on serve, so there's never a double zoom or double toggle.

**If a Reading Room checkout exists**, file the doc in with its
helper rather than hand-editing the registry:

```
cd <reading-room-checkout>
deno task add-doc --src /path/to/your-doc.html --topic <topic-id> \
  --title "Title" --kind "Guide · Engineering Ref" --desc "One line." \
  --foot-left "2026·06·07" --foot-right "repo-or-source" \
  [--slug custom-slug] [--visibility private|shared] [--review] \
  [--new-topic "§ 0N|topic-id|Topic Name|Short"]
```

It validates the slug is unique, copies the file to
`_migrated/<slug>.html`, and inserts a registry entry (preserving the
file's comments). Then `deno task serve` shows it.

**To hand-edit instead**, add an object to the right topic's `docs`
array in `registry.jsonc`:

| Field | Meaning |
|---|---|
| `slug` | output filename stem → `/docs/<slug>` (unique) |
| `title` / `kind` / `desc` | card title, eyebrow label, one-line italic blurb |
| `footLeft` / `footRight` | card footer left/right (e.g. date · source repo) |
| `src` | source HTML relative to the Reading Room's parent directory; overridden when `_migrated/<slug>.html` exists |
| `visibility` | `private` (local only) or `shared` (eligible for a future shared remote) |
| `review` | `true` pins it to the "For Review" section with a copper chip |

## When NOT to use this skill

- Customer-facing marketing pages or landing copy
- Live dashboards, status pages, anything dynamic or stateful
- Short READMEs and quick notes (overkill)
- Slide decks
- Any context where the user has explicitly asked for a different
  visual language

## Visualizations

When the document includes charts, plots, or any quantitative
visualization, apply Tufte's principles (high data-ink ratio, no
chartjunk, graphical integrity, small multiples) — if a `tufte-viz`
skill is available, invoke it *before* drawing them; they compose
directly with this style. The editorial-print palette already
constrains you toward restraint. Practical defaults that follow from
the combination:

- Hand-author SVG over chart libraries when the data is small enough
  (under ~50 marks) — you get full control of ink and labels.
- Use `--ink` / `--ink-soft` for data marks, `--copper` only for the
  one element you want the reader to look at first, `--rule` for
  axes. Avoid gridlines; if you need them, drop to `--rule` at low
  opacity.
- JetBrains Mono for axis tick labels and small annotations; italic
  Fraunces for figure titles when the figure is the centerpiece.
- Small multiples beat a single dense chart — the `figure.topology`
  framing already documented in the design language works for grids
  of small charts too.
- Captions go *under* the figure in `--ink-mute`, italic Fraunces,
  ~14px. No chart legend if you can label the marks directly.

Don't slot in a generic library chart (Chart.js default theme, etc.)
and call it done — it will fight the page's visual register.

## Companion markdown

When the document is markdown-first and HTML is the rendering, keep
the two in sync: the content shape (eyebrow → h1 → lede → TOC →
numbered sections → footer) translates cleanly, and pandoc-style
conversion is the path of least resistance.

When the document is HTML-native, there's no markdown source to
maintain — don't generate one as a "companion" unless the user
explicitly asks. A lossy markdown shadow of a richly-illustrated HTML
doc is worse than no markdown at all, because future edits will drift.
