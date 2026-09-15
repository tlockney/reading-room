# Reading Room — paged reading mode — design

- Date: 2026-09-15
- Status: approved in conversation (gesture-driven turns, slide transition, narrow viewports only);
  implemented alongside this spec.
- Builds on: the canonical editorial bundle (`assets/editorial/{head,body}.html`), the PWA
  (`2026-08-23`), and the `data-ed-theme="off"` opt-out precedent in `render.ts`.

> In `_specs/` (not `docs/`) because `deno task build` empties `docs/` on every run.

## Goal

Reading on a phone, especially in the installed PWA, should feel like an ebook: the document is
divided into screen-sized pages, you turn a page with a tap or a swipe, and a small counter tells
you where you are. Scrolling stays the default; paged mode is a per-device preference toggled from
the same bottom-right control cluster as the dark-mode button. It has to work across every house
style the library serves (editorial longform, field dossier, parchment, arbitrary migrated docs)
without any per-document markup.

## Mechanism: CSS multi-column pagination

The technique epub.js and Readium use. In paged mode the body becomes a fixed-height,
hidden-overflow multi-column container whose column width equals the viewport width. The browser
flows the whole document into columns; each column is one page. Turning a page is a horizontal
scroll of the body by one viewport width. Nothing measures text or splits the DOM, so it works on
any document.

```
html[data-ed-paged="on"] body {
  height: 100dvh; overflow: hidden; margin: 0; padding: 0;
  column-width: 100vw; column-gap: 0; column-fill: auto;
}
```

The body is the scroll container. Programmatic scrolling works on a hidden-overflow box, and because
nothing is transformed, the existing `position: fixed` chrome (dark toggle, zoom overlay, admin
buttons, grain) stays put. Whole-body pagination means a masthead or dossier cover becomes the title
page and the contents list page two, which reads as a book rather than a bug.

## Key design decisions

### D1. It is engine behavior, shipped in the editorial bundle

Per the engine/content-home rule, paged reading is engine behavior: it rides the canonical editorial
bundle so every served, built, and downloaded doc gets it on a CLI upgrade, and skill-authored
standalone docs get it baked in. The cost is the drift test: the skill template in
`skill/editorial-longform-html/assets/` is updated in the same change.

### D2. Narrow viewports only, scroll by default, remembered per device

The toggle (`Paged` / `Scroll`, named for the target state like `Dark` / `Light`) is only rendered
at the bundle's existing 720px mobile breakpoint. The preference is stored in `localStorage` under
`editorial-paged`. If a paged viewport is widened past the breakpoint, the layout reverts to scroll
and re-enters paged when narrowed again; the preference is untouched.

### D3. Opt-out attribute, mirroring the theme toggle

`data-ed-paged="off"` on `<html>` suppresses the feature. `renderIndex` sets it on the library index
(a list, not a reading surface). The `forceDossierThemeOff` precedent is followed but no house style
needs a forced opt-out.

### D4. Gestures: tap zones, swipe that tracks the finger, keys

- Tap in the left or right 30% of the viewport turns back or forward. Taps on links, buttons, form
  controls, zoomable figures, code blocks, and tables are left to their own handlers.
- A horizontal swipe drags the page with the finger (`scrollLeft` follows the pointer), then snaps
  to the nearest page on release; a drag past 20% of the width or a quick flick commits a turn. The
  snap and the tap-turn animate with smooth scrolling. `touch-action: pan-y` on the body leaves
  vertical gestures and pinch-zoom to the browser.
- Arrow keys, space, and PageUp/PageDown turn pages on a keyboard.

### D5. Chrome: a counter, a progress hairline, nothing else

A centered bottom pill in JetBrains Mono reading `§ 12 / 84`, styled like the zoom controls, and a
2px copper hairline at the top edge whose width is the reading progress. Both respect the dark theme
through the existing CSS variables and hide under print and the zoom overlay.

### D6. Fragmentation rules for blocks that fight columns

Scroll containers cannot fragment, so the bundle's mobile rules that make `pre` and `table`
horizontally scrollable would turn them into monolithic blocks that clip at a page edge. In paged
mode code wraps (`white-space: pre-wrap`) and tables render as tables again with wrapping cells, so
both break across pages like an ebook. Figures, images, and tables avoid internal breaks where they
fit, and images are capped below one page height so an unbreakable figure never overflows.

### D7. Position memory and anchor navigation

Page counts change with font loading, orientation, and Mermaid rendering, so the stored position is
not a page number. It is the id of the last id-bearing heading at or before the current page plus
the number of pages past it. Restore finds that heading's page again and adds the delta, clamped.
Stored per document in `localStorage` under `editorial-paged-pos:<pathname>`.

Same-page anchor links (contents lists, footnotes) are intercepted and mapped to the page containing
the target, since `scrollIntoView` does nothing useful in a hidden-overflow column layout. The
initial `location.hash` is handled the same way.

### D8. Recompute on reflow

Page count and current position are recomputed after `document.fonts.ready`, on `resize`, and on DOM
mutations (debounced), the same MutationObserver signal the zoom bundle uses for Mermaid. The
current position is held across recomputes via the D7 anchor.

### D9. Annotations are hidden in paged mode

The serve-only margin cards and marks are positioned from vertical scroll offsets and would land in
the wrong place. `admin.css` hides them under `data-ed-paged="on"`; annotation creation from a
selection is unaffected. Paged-mode annotation layout is a follow-up.

## Alternatives considered

- **Transform-based slide.** Translating the body moves every fixed descendant with it. Rejected.
- **Scroll-snap with native horizontal scrolling.** Columns are not elements, so they cannot be snap
  targets without wrapping every page in a DOM node. Rejected.
- **Crossfade or 3D curl.** A curl fights the editorial restraint and costs a lot of code; slide was
  chosen.
- **Toggle everywhere.** A two-column spread on an iPad in landscape is a natural extension of the
  same column layout, deferred until the phone experience is proven.

## Testing

The pure paging math (page for an x-offset, snap decision after a drag, anchor-based save and
restore) is exposed by the inline script as `window.__edpaged` before it touches the DOM. A Deno
test extracts that script from `body.html` and evaluates it against a minimal fake `document`, in
the style of `sw_behavior_test.ts`, so the logic is covered without a browser. Partial and render
tests pin the markers, the opt-out rule, and the index opt-out. Real-device verification is manual:
one doc per house style on a phone, portrait and landscape, light and dark.

## Assumptions to validate on a device

1. WebKit lays out overflow columns in a hidden-overflow body and allows programmatic horizontal
   scrolling of it (this is what epub.js relies on inside an iframe; here it is the top-level body).
2. `touch-action: pan-y` delivers horizontal pointer moves without the browser claiming them.
3. `100dvh` behaves in the installed PWA where there is no URL bar.
