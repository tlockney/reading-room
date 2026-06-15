/**
 * Reading Room — browser admin layer (served only by serve.ts; never
 * published). Reads its page context from window.__RR (injected by admin.ts):
 *   index → manage mode: per-card review/visibility/remove controls
 *   doc   → breadcrumb cluster (review chip, § notes) + anchored marginalia
 * All registry state changes go through /api/ and finish with a reload (the
 * server re-renders; index grouping like "For Review" stays correct for free).
 */
// deno-lint-ignore-file no-window no-window-prefix -- browser-only module; `window` is real here
import { describeRange, findAnchor } from "./anchor.js";
import { stackTops } from "./layout.js";

const ctx = window.__RR;
if (ctx && ctx.page === "index") initIndex(ctx);
else if (ctx && ctx.page === "doc") initDoc(ctx);
initSwitcher();

// --- shared helpers ----------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch (_) { /* keep status text */ }
    throw new Error(msg);
  }
  return res.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  node.dataset.rradmin = "1";
  return node;
}

let toastNode = null;
let toastTimer = 0;
function toast(msg) {
  if (!toastNode) {
    toastNode = el("div", "rradmin-toast");
    document.body.appendChild(toastNode);
  }
  toastNode.textContent = msg;
  toastNode.classList.add("rradmin-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove("rradmin-show"), 2200);
}

function run(promise) {
  promise
    .then(() => location.reload())
    .catch((err) => toast(`failed: ${err.message}`));
}

async function initSwitcher() {
  let peers;
  try {
    peers = (await api("GET", "/api/peers")).peers;
  } catch (_) {
    return; // discovery unavailable → no switcher
  }
  if (!peers || !peers.length) return; // no peers → no clutter
  const wrap = el("div", "rr-switcher");
  wrap.appendChild(el("span", "rr-switcher-label", "Libraries"));
  const select = el("select", "rr-switcher-select");
  const here = el("option", null, "This library");
  here.value = "";
  select.appendChild(here);
  for (const p of peers) {
    const opt = el("option", null, (p.identity && p.identity.name) || p.name || p.url);
    opt.value = p.url;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    if (select.value) location.href = select.value;
  });
  wrap.appendChild(select);
  document.body.appendChild(wrap);
}

/** Two-step destructive confirm: first click arms ("confirm?", 3s), second
 * click runs. Nothing destructive happens on a single click. */
function armDelete(btn, label, onConfirm) {
  let timer = 0;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!btn.classList.contains("rradmin-armed")) {
      btn.classList.add("rradmin-armed");
      btn.textContent = "confirm?";
      timer = setTimeout(() => {
        btn.classList.remove("rradmin-armed");
        btn.textContent = label;
      }, 3000);
      return;
    }
    clearTimeout(timer);
    onConfirm();
  });
}

const fmtDate = (iso) => iso.slice(0, 10).replaceAll("-", "·");

// --- index: § manage mode ----------------------------------------------------

function initIndex(ctx) {
  if (ctx.readonly) return; // view-only exposure: no management layer at all
  const KEY = "rradmin-manage";
  const btn = el("button", "rradmin-manage", "§ Manage");
  btn.type = "button";
  document.body.appendChild(btn);

  let on = false;
  try {
    on = sessionStorage.getItem(KEY) === "1";
  } catch (_) { /* storage unavailable */ }

  function setMode(next) {
    on = next;
    btn.setAttribute("aria-pressed", String(on));
    try {
      sessionStorage.setItem(KEY, on ? "1" : "0");
    } catch (_) { /* storage unavailable */ }
    document.querySelectorAll(".rradmin-controls").forEach((c) => c.remove());
    if (on) document.querySelectorAll("a.card").forEach(addControls);
  }

  function addControls(card) {
    const href = card.getAttribute("href") || "";
    const m = href.match(/^\/docs\/([A-Za-z0-9_-]+)$/);
    if (!m) return;
    const slug = m[1];
    const state = ctx.docs[slug];
    if (!state) return;

    const row = el("div", "rradmin-controls");
    // clicks inside the row must not follow the card link
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const review = el(
      "button",
      state.review ? "rradmin-on" : "",
      `review · ${state.review ? "on" : "off"}`,
    );
    review.type = "button";
    review.addEventListener(
      "click",
      () => run(api("PATCH", `/api/docs/${slug}`, { review: !state.review })),
    );

    const vis = el("button", state.visibility === "shared" ? "rradmin-on" : "", state.visibility);
    vis.type = "button";
    vis.title = "Toggle publish eligibility (private ↔ shared)";
    vis.addEventListener("click", () =>
      run(api("PATCH", `/api/docs/${slug}`, {
        visibility: state.visibility === "shared" ? "private" : "shared",
      })));

    const remove = el("button", "", "remove");
    remove.type = "button";
    armDelete(remove, "remove", () => run(api("DELETE", `/api/docs/${slug}`)));

    row.append(review, vis, remove);
    card.appendChild(row);
  }

  btn.addEventListener("click", () => setMode(!on));
  setMode(on);
}

// --- doc page: cluster + marginalia -------------------------------------------

function initDoc(ctx) {
  const bar = document.querySelector("[data-library-nav] > div");
  const cluster = el("span", "rradmin-cluster");
  if (bar) bar.appendChild(cluster);

  if (!ctx.readonly && bar) {
    const chip = el(
      "button",
      ctx.doc.review ? "rradmin-on" : "",
      ctx.doc.review ? "▸ in review — promote" : "mark for review",
    );
    chip.type = "button";
    chip.title = ctx.doc.review ? "Promote out of review" : "Pin to For Review";
    chip.addEventListener(
      "click",
      () => run(api("PATCH", `/api/docs/${ctx.doc.slug}`, { review: !ctx.doc.review })),
    );
    cluster.appendChild(chip);
  }

  const notesBtn = el("button", "", "§ …");
  notesBtn.type = "button";
  notesBtn.title = "Annotations — show all in the margin";
  cluster.appendChild(notesBtn);

  // reviewed annotations retire from the margin; ✓ n toggles them back in
  const revBtn = el("button", "", "✓ …");
  revBtn.type = "button";
  revBtn.title = "Show / hide reviewed annotations";
  revBtn.style.display = "none";
  cluster.appendChild(revBtn);

  // --- text extraction shared by anchoring + selection capture
  // Structural chrome (masthead, minimap/toc navs, page footer) is not
  // annotatable and stays out of the anchoring corpus — only content counts.
  const SKIP = "[data-library-nav],[data-rradmin],.edtheme,.edzoom-overlay,.edzoom-controls," +
    "header,footer,nav,aside,script,style,noscript";
  function collectText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return n.parentElement && n.parentElement.closest(SKIP)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = "";
    const spans = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      spans.push({ node: n, start: text.length });
      text += n.nodeValue;
    }
    return { text, spans };
  }

  function rangeFromOffsets(spans, start, end) {
    const range = document.createRange();
    let started = false;
    for (const sp of spans) {
      const len = sp.node.nodeValue.length;
      if (!started && start < sp.start + len) {
        range.setStart(sp.node, Math.max(0, start - sp.start));
        started = true;
      }
      if (started && end <= sp.start + len) {
        range.setEnd(sp.node, Math.max(0, end - sp.start));
        return range;
      }
    }
    return null;
  }

  function offsetsFromSelection(spans, range) {
    let start = -1;
    let end = -1;
    for (const sp of spans) {
      if (!range.intersectsNode(sp.node)) continue;
      if (start === -1) {
        start = sp.node === range.startContainer ? sp.start + range.startOffset : sp.start;
      }
      end = sp.node === range.endContainer
        ? sp.start + range.endOffset
        : sp.start + sp.node.nodeValue.length;
    }
    return start === -1 || end <= start ? null : { start, end };
  }

  // --- marginalia rendering
  let comments = [];
  let anchored = new Map(); // id → Range
  let markLayer = null;
  let panel = null;
  let showAll = false; // § n toggles every annotation laid out as margin cards
  const SHOWALL_KEY = `rradmin-showall:${ctx.doc.slug}`;
  try {
    showAll = sessionStorage.getItem(SHOWALL_KEY) === "1";
  } catch (_) { /* storage unavailable */ }
  let showReviewed = false; // reviewed notes stay hidden unless toggled in
  const SHOWREV_KEY = `rradmin-showrev:${ctx.doc.slug}`;
  try {
    showReviewed = sessionStorage.getItem(SHOWREV_KEY) === "1";
  } catch (_) { /* storage unavailable */ }

  function setShowReviewed(next) {
    showReviewed = next;
    try {
      sessionStorage.setItem(SHOWREV_KEY, next ? "1" : "0");
    } catch (_) { /* storage unavailable */ }
    renderMarks();
  }

  /** Flip the reviewed marker on one annotation, then re-render (and reopen
   * the list panel when the change was made from it). */
  function setReviewed(c, next, reopenList = false) {
    api("PATCH", `/api/docs/${ctx.doc.slug}/comments/${c.id}`, { reviewed: next })
      .then(() => refresh(reopenList))
      .then(() => toast(next ? "marked reviewed" : "back in review"))
      .catch((err) => toast(`failed: ${err.message}`));
  }

  /** Left edge for the annotation gutter (document coords): just right of the
   * content column, derived from the breadcrumb bar's inner column, which
   * shares the page's max-width geometry. Per-block right edges are wrong for
   * indented blocks (code, blockquotes) — the gutter must be column-constant.
   * Null when the bar is missing (fall back to per-block placement). */
  function gutterLeft() {
    const inner = document.querySelector("[data-library-nav] > div");
    if (!inner) return null;
    const r = inner.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(inner).paddingRight) || 0;
    return Math.min(
      r.right - pad + 14,
      document.documentElement.clientWidth - 34,
    ) + window.scrollX;
  }

  /** Card width that fits right of the gutter, or null when too narrow. */
  function cardWidth(gutter) {
    const room = document.documentElement.clientWidth - (gutter - window.scrollX) - 12;
    return room >= 180 ? Math.min(room, 320) : null;
  }

  function setShowAll(next) {
    showAll = next;
    try {
      sessionStorage.setItem(SHOWALL_KEY, next ? "1" : "0");
    } catch (_) { /* storage unavailable */ }
    renderMarks();
  }

  function clearHighlight() {
    if (window.CSS && CSS.highlights) CSS.highlights.delete("rradmin");
  }

  function closePanel() {
    if (panel) panel.remove();
    panel = null;
    clearHighlight();
  }

  function openPanel(x, y, build) {
    closePanel();
    panel = el("div", "rradmin-panel");
    build(panel);
    document.body.appendChild(panel);
    const w = panel.offsetWidth;
    panel.style.left = `${
      Math.max(8, Math.min(x, document.documentElement.clientWidth - w - 8))
    }px`;
    panel.style.top = `${y}px`;
  }

  function highlight(range) {
    if (window.CSS && CSS.highlights && typeof Highlight === "function") {
      CSS.highlights.set("rradmin", new Highlight(range));
    }
  }

  function renderMarks() {
    if (markLayer) markLayer.remove();
    markLayer = el("div", "");
    markLayer.style.position = "absolute";
    markLayer.style.top = "0";
    markLayer.style.left = "0";
    document.body.appendChild(markLayer);
    anchored = new Map();

    const gutter = gutterLeft();
    const { text, spans } = collectText();
    const reviewedCount = comments.filter((c) => c.reviewed).length;
    const active = comments.filter((c) => showReviewed || !c.reviewed);
    const hits = [];
    const orphans = [];
    for (const c of active) {
      const hit = findAnchor(text, c);
      const range = hit && rangeFromOffsets(spans, hit.start, hit.end);
      if (!range) {
        orphans.push(c);
        continue;
      }
      anchored.set(c.id, range);
      const rect = range.getBoundingClientRect();
      const blockEl = range.startContainer.parentElement;
      const block = blockEl ? blockEl.getBoundingClientRect() : rect;
      hits.push({
        c,
        range,
        top: rect.top + window.scrollY,
        left: gutter ?? Math.min(
          block.right + 10 + window.scrollX,
          document.documentElement.clientWidth - 30,
        ),
      });
    }
    hits.sort((a, b) => a.top - b.top);
    notesBtn.textContent = `§ ${comments.length - reviewedCount}`;
    notesBtn.classList.toggle("rradmin-on", showAll);
    revBtn.style.display = reviewedCount ? "" : "none";
    revBtn.textContent = `✓ ${reviewedCount}`;
    revBtn.classList.toggle("rradmin-on", showReviewed);
    if (showAll && gutter !== null && cardWidth(gutter) !== null) {
      renderCards(hits, orphans, gutter);
    } else {
      renderDots(hits);
    }
  }

  function renderDots(hits) {
    let prevTop = -Infinity;
    for (const h of hits) {
      const top = h.top - prevTop < 20 ? prevTop + 20 : h.top;
      prevTop = top;
      const mark = el(
        "button",
        h.c.reviewed ? "rradmin-mark rradmin-reviewed" : "rradmin-mark",
        "§",
      );
      mark.type = "button";
      mark.title = h.c.note.slice(0, 80);
      mark.style.top = `${top - 2}px`;
      mark.style.left = `${h.left}px`;
      mark.addEventListener("click", (e) => {
        e.stopPropagation();
        highlight(h.range);
        openNotePanel(h.c, e.pageX, e.pageY + 14);
      });
      markLayer.appendChild(mark);
    }
  }

  /** Show-all mode: every annotation as a margin card beside its anchor.
   * Orphans pin to the top of the stack; stackTops pushes overlapping cards
   * down so nearby anchors never collide. */
  function renderCards(hits, orphans, gutter) {
    const width = cardWidth(gutter);
    // flow position, not getBoundingClientRect — the nav is sticky, so its
    // rect follows the scroll; orphan cards must pin to the document top
    const nav = document.querySelector("[data-library-nav]");
    const contentTop = (nav ? nav.offsetTop + nav.offsetHeight : 0) + 16;
    const entries = [
      ...orphans.map((c) => ({ c, range: null, top: contentTop })),
      ...hits,
    ];
    const cards = entries.map((h) => {
      const card = el("div", h.c.reviewed ? "rradmin-card rradmin-reviewed" : "rradmin-card");
      card.style.left = `${gutter}px`;
      card.style.width = `${width}px`;
      const eyebrow = el("p", "rradmin-eyebrow");
      const label = h.range ? fmtDate(h.c.created) : "unanchored";
      eyebrow.append(el("span", "", h.c.reviewed ? `✓ ${label}` : label));
      if (!ctx.readonly) {
        const actions = el("span", "rradmin-card-actions");
        const rev = el("button", h.c.reviewed ? "rradmin-del rradmin-on" : "rradmin-del", "✓");
        rev.type = "button";
        rev.title = h.c.reviewed ? "Reviewed — click to put back in review" : "Mark reviewed";
        rev.addEventListener("click", () => setReviewed(h.c, !h.c.reviewed));
        actions.append(rev);
        const del = el("button", "rradmin-del", "×");
        del.type = "button";
        del.title = "Delete annotation";
        armDelete(del, "×", () => {
          api("DELETE", `/api/docs/${ctx.doc.slug}/comments/${h.c.id}`)
            .then(() => refresh())
            .then(() => toast("annotation deleted"))
            .catch((err) => toast(`failed: ${err.message}`));
        });
        actions.append(del);
        eyebrow.append(actions);
      }
      const quote = el("p", "rradmin-quote", h.c.quote);
      const note = el("p", "rradmin-note", h.c.note);
      card.append(eyebrow, quote, note);
      if (h.range) {
        card.addEventListener("mouseenter", () => highlight(h.range));
        card.addEventListener("mouseleave", clearHighlight);
        quote.title = "Scroll to passage";
        quote.addEventListener("click", () => {
          const target = h.range.startContainer.parentElement;
          if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
          highlight(h.range);
        });
      }
      markLayer.appendChild(card);
      return card;
    });
    // measure after insertion, then stack: at the anchor, or pushed below the
    // previous card when they would overlap
    const tops = stackTops(
      entries.map((h, i) => ({ anchor: h.top, height: cards[i].offsetHeight })),
      10,
    );
    cards.forEach((card, i) => {
      card.style.top = `${tops[i]}px`;
    });
  }

  function openNotePanel(c, x, y) {
    openPanel(x, y, (p) => {
      const eyebrow = el("p", "rradmin-eyebrow");
      const label = fmtDate(c.created);
      eyebrow.append(el("span", "", c.reviewed ? `✓ ${label}` : label));
      const quote = el("p", "rradmin-quote", c.quote);
      const note = el("p", "", c.note);
      const row = el("div", "rradmin-row");
      const close = el("button", "", "close");
      close.type = "button";
      close.addEventListener("click", closePanel);
      row.appendChild(close);
      if (!ctx.readonly) {
        const rev = el(
          "button",
          c.reviewed ? "rradmin-on" : "",
          c.reviewed ? "✓ reviewed" : "mark reviewed",
        );
        rev.type = "button";
        rev.addEventListener("click", () => {
          closePanel();
          setReviewed(c, !c.reviewed);
        });
        row.appendChild(rev);
        const del = el("button", "", "delete");
        del.type = "button";
        armDelete(del, "delete", () => {
          api("DELETE", `/api/docs/${ctx.doc.slug}/comments/${c.id}`)
            .then(() => {
              closePanel();
              return refresh();
            })
            .then(() => toast("annotation deleted"))
            .catch((err) => toast(`failed: ${err.message}`));
        });
        row.appendChild(del);
      }
      p.append(eyebrow, quote, note, row);
    });
  }

  function openListPanel() {
    const rect = notesBtn.getBoundingClientRect();
    const items = comments.filter((c) => showReviewed || !c.reviewed);
    const hidden = comments.length - items.length;
    openPanel(rect.left + window.scrollX - 200, rect.bottom + window.scrollY + 10, (p) => {
      p.appendChild(el("p", "rradmin-eyebrow", `§ annotations — ${items.length}`));
      if (comments.length === 0) {
        p.appendChild(el("p", "", "None yet. Select a passage to annotate it."));
      } else {
        const list = el("ul", "rradmin-list");
        for (const c of items) {
          const li = el("li", c.reviewed ? "rradmin-reviewed" : "");
          const jump = el(
            "span",
            "rradmin-jump",
            c.note.length > 70 ? c.note.slice(0, 70) + "…" : c.note,
          );
          const range = anchored.get(c.id);
          if (range) {
            jump.addEventListener("click", () => {
              closePanel();
              const target = range.startContainer.parentElement;
              if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
              highlight(range);
            });
          } else {
            li.appendChild(el("span", "rradmin-orphan", "unanchored"));
          }
          li.prepend(jump);
          if (!ctx.readonly) {
            const rev = el("button", c.reviewed ? "rradmin-del rradmin-on" : "rradmin-del", "✓");
            rev.type = "button";
            rev.title = c.reviewed ? "Reviewed — click to put back in review" : "Mark reviewed";
            rev.addEventListener("click", () => setReviewed(c, !c.reviewed, true));
            li.appendChild(rev);
            const del = el("button", "rradmin-del", "×");
            del.type = "button";
            del.title = "Delete annotation";
            armDelete(del, "×", () => {
              api("DELETE", `/api/docs/${ctx.doc.slug}/comments/${c.id}`)
                .then(() => refresh(true))
                .then(() => toast("annotation deleted"))
                .catch((err) => toast(`failed: ${err.message}`));
            });
            li.appendChild(del);
          }
          list.appendChild(li);
        }
        p.appendChild(list);
        if (hidden) {
          p.appendChild(el("p", "rradmin-orphan", `${hidden} reviewed — hidden (✓ toggles)`));
        }
      }
      const row = el("div", "rradmin-row");
      const close = el("button", "", "close");
      close.type = "button";
      close.addEventListener("click", closePanel);
      row.appendChild(close);
      p.appendChild(row);
    });
  }

  async function refresh(reopenList = false) {
    comments = await api("GET", `/api/docs/${ctx.doc.slug}/comments`);
    renderMarks();
    if (reopenList) openListPanel();
  }

  revBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setShowReviewed(!showReviewed);
  });

  notesBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const gutter = gutterLeft();
    if (gutter !== null && cardWidth(gutter) !== null) {
      // wide enough for margin cards: § n toggles show-all
      closePanel();
      setShowAll(!showAll);
    } else if (panel) {
      closePanel();
    } else {
      openListPanel(); // narrow viewport: the list panel is the overview
    }
  });

  // --- creating annotations from a selection
  let fab = null;
  function hideFab() {
    if (fab) fab.remove();
    fab = null;
  }

  function selectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const elNode = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (!elNode || elNode.closest(SKIP)) return null;
    return range;
  }

  function showFab() {
    hideFab();
    const range = selectionRange();
    if (!range) return;
    // A static copy: tapping the button collapses the live selection on touch
    // devices (and some Safari setups) before the click handler runs.
    const captured = range.cloneRange();
    const rect = range.getBoundingClientRect();
    fab = el("button", "rradmin-fab", "§ annotate");
    fab.type = "button";
    // keep the selection alive when the button is pressed
    fab.addEventListener("mousedown", (e) => e.preventDefault());
    fab.addEventListener("click", () => {
      const r = selectionRange() ?? captured;
      const liveRect = r.getBoundingClientRect();
      const { text, spans } = collectText();
      const offsets = offsetsFromSelection(spans, r);
      hideFab();
      if (!offsets) return toast("could not anchor that selection");
      const desc = describeRange(text, offsets.start, offsets.end);
      openComposer(desc, liveRect);
    });
    fab.style.top = `${rect.bottom + window.scrollY + 8}px`;
    fab.style.left = `${
      Math.min(rect.right + window.scrollX - 40, document.documentElement.clientWidth - 130)
    }px`;
    document.body.appendChild(fab);
  }

  function openComposer(desc, anchorRect) {
    openPanel(
      anchorRect.left + window.scrollX,
      anchorRect.bottom + window.scrollY + 12,
      (p) => {
        const eyebrow = el("p", "rradmin-eyebrow", "§ new annotation");
        const quote = el("p", "rradmin-quote", desc.quote);
        const input = el("textarea", "");
        input.placeholder = "Note…";
        const row = el("div", "rradmin-row");
        const cancel = el("button", "", "cancel");
        cancel.type = "button";
        cancel.addEventListener("click", closePanel);
        const save = el("button", "rradmin-primary", "save");
        save.type = "button";
        save.addEventListener("click", () => {
          const note = input.value.trim();
          if (!note) return toast("write a note first");
          api("POST", `/api/docs/${ctx.doc.slug}/comments`, { ...desc, note })
            .then(() => {
              closePanel();
              return refresh();
            })
            .then(() => toast("noted"))
            .catch((err) => toast(`failed: ${err.message}`));
        });
        row.append(cancel, save);
        p.append(eyebrow, quote, input, row);
        input.focus();
      },
    );
  }

  if (!ctx.readonly) {
    // selectionchange covers every way a selection is made — mouse drag,
    // double-click, keyboard (shift+arrows), and iOS/iPadOS long-press —
    // where mouseup-only wiring missed touch and keyboard entirely. Debounced
    // so the fab settles after the selection stops moving.
    let selTimer = 0;
    document.addEventListener("selectionchange", () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        // typing in the composer moves the textarea's selection — leave it be
        const active = document.activeElement;
        if (active instanceof Element && active.closest(".rradmin-panel")) return;
        showFab();
      }, 250);
    });
  }
  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") {
      hideFab();
      closePanel();
      clearHighlight();
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (
      panel && e.target instanceof Element &&
      !e.target.closest(".rradmin-panel,.rradmin-mark,.rradmin-cluster")
    ) {
      closePanel();
    }
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderMarks, 200);
  });

  if (document.fonts) document.fonts.ready.then(() => renderMarks());
  window.addEventListener("load", () => renderMarks());

  refresh().catch((err) => toast(`annotations unavailable: ${err.message}`));
}
