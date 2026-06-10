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

const ctx = window.__RR;
if (ctx && ctx.page === "index") initIndex(ctx);
else if (ctx && ctx.page === "doc") initDoc(ctx);

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
    let disarmTimer = 0;
    remove.addEventListener("click", () => {
      if (!remove.classList.contains("rradmin-armed")) {
        remove.classList.add("rradmin-armed");
        remove.textContent = "confirm?";
        disarmTimer = setTimeout(() => {
          remove.classList.remove("rradmin-armed");
          remove.textContent = "remove";
        }, 3000);
        return;
      }
      clearTimeout(disarmTimer);
      run(api("DELETE", `/api/docs/${slug}`));
    });

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
  notesBtn.title = "Annotations";
  cluster.appendChild(notesBtn);

  // --- text extraction shared by anchoring + selection capture
  const SKIP =
    "[data-library-nav],[data-rradmin],.edtheme,.edzoom-overlay,.edzoom-controls,script,style,noscript";
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

    const { text, spans } = collectText();
    const hits = [];
    for (const c of comments) {
      const hit = findAnchor(text, c);
      if (!hit) continue;
      const range = rangeFromOffsets(spans, hit.start, hit.end);
      if (!range) continue;
      anchored.set(c.id, range);
      const rect = range.getBoundingClientRect();
      const blockEl = range.startContainer.parentElement;
      const block = blockEl ? blockEl.getBoundingClientRect() : rect;
      hits.push({
        c,
        range,
        top: rect.top + window.scrollY,
        left: Math.min(
          block.right + 10 + window.scrollX,
          document.documentElement.clientWidth - 30,
        ),
      });
    }
    hits.sort((a, b) => a.top - b.top);
    let prevTop = -Infinity;
    for (const h of hits) {
      const top = h.top - prevTop < 20 ? prevTop + 20 : h.top;
      prevTop = top;
      const mark = el("button", "rradmin-mark", "§");
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
    notesBtn.textContent = `§ ${comments.length}`;
  }

  function openNotePanel(c, x, y) {
    openPanel(x, y, (p) => {
      const eyebrow = el("p", "rradmin-eyebrow");
      eyebrow.append(el("span", "", c.created.slice(0, 10).replaceAll("-", "·")));
      const quote = el("p", "rradmin-quote", c.quote);
      const note = el("p", "", c.note);
      const row = el("div", "rradmin-row");
      const close = el("button", "", "close");
      close.type = "button";
      close.addEventListener("click", closePanel);
      row.appendChild(close);
      if (!ctx.readonly) {
        const del = el("button", "", "delete");
        del.type = "button";
        del.addEventListener("click", () => {
          api("DELETE", `/api/docs/${ctx.doc.slug}/comments/${c.id}`)
            .then(() => {
              closePanel();
              return refresh();
            })
            .then(() => toast("annotation removed"))
            .catch((err) => toast(`failed: ${err.message}`));
        });
        row.appendChild(del);
      }
      p.append(eyebrow, quote, note, row);
    });
  }

  function openListPanel() {
    const rect = notesBtn.getBoundingClientRect();
    openPanel(rect.left + window.scrollX - 200, rect.bottom + window.scrollY + 10, (p) => {
      p.appendChild(el("p", "rradmin-eyebrow", `§ annotations — ${comments.length}`));
      if (comments.length === 0) {
        p.appendChild(el("p", "", "None yet. Select a passage to annotate it."));
      } else {
        const list = el("ul", "rradmin-list");
        for (const c of comments) {
          const li = el("li", "");
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
            const del = el("button", "rradmin-del", "×");
            del.type = "button";
            del.title = "Delete annotation";
            del.addEventListener("click", () => {
              api("DELETE", `/api/docs/${ctx.doc.slug}/comments/${c.id}`)
                .then(() => refresh(true))
                .catch((err) => toast(`failed: ${err.message}`));
            });
            li.appendChild(del);
          }
          list.appendChild(li);
        }
        p.appendChild(list);
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

  notesBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel) closePanel();
    else openListPanel();
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
    const rect = range.getBoundingClientRect();
    fab = el("button", "rradmin-fab", "§ annotate");
    fab.type = "button";
    // keep the selection alive when the button is pressed
    fab.addEventListener("mousedown", (e) => e.preventDefault());
    fab.addEventListener("click", () => {
      const r = selectionRange();
      if (!r) return hideFab();
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
    document.addEventListener("mouseup", (e) => {
      if (e.target instanceof Element && e.target.closest(".rradmin-panel,.rradmin-fab")) return;
      setTimeout(showFab, 0);
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
