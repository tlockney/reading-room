# Reading Room

A local, editorially-styled library of long-form documents, plus the **editorial-longform-html**
authoring skill that produces them. The site structure lives in **`registry.jsonc`**. Tooling is
Deno — no build step.

Two halves, one visual language:

- **The library** (this directory) — registers standalone HTML docs and serves them with shared
  navigation, click-to-zoom figures, and a light/espresso theme toggle.
- **The skill** (`skill/editorial-longform-html/`) — a Claude Code skill for authoring documents in
  the editorial-print aesthetic: cream paper, Fraunces + Source Serif + JetBrains Mono,
  forest/copper accents, numbered sections. Install it by copying (or symlinking) the directory into
  `~/.claude/skills/`:

      ln -s "$(pwd)/skill/editorial-longform-html" ~/.claude/skills/

## Use it

    deno task serve              # serve on 127.0.0.1:8413 — rendered live, no build step
    PORT=9000 deno task serve    # …a different port  (also: deno task serve 9000)

    deno task build              # write STATIC files (only needed to publish)
    deno task publish            # build the shared subset + run publish.jsonc's command
    deno task test               # render injection, registry insertion, skill drift

`deno task serve` renders every page on the fly from `registry.jsonc` and the source docs, bound to
**localhost only**. Editing the registry or any doc shows up on the next refresh — no rebuild, no
restart. It also carries the management layer — review toggles, visibility, removal, and annotations
— which exists only on the live server, never in published output.

## Always-on, over Tailscale (optional)

    ./agent.sh install     # load a LaunchAgent + expose over your tailnet (HTTPS)
    ./agent.sh status      # agent + tailscale serve state
    ./agent.sh logs        # tail the agent logs
    ./agent.sh uninstall   # unload the agent + reset tailscale serve

The agent (macOS launchd) runs the server on `127.0.0.1:8413` (starts at login, auto-restarts via
`KeepAlive`), and `tailscale serve` fronts it at `https://<your-machine>.<your-tailnet>.ts.net/` —
reachable only from your tailnet, over HTTPS, with no raw LAN exposure. Because serving is dynamic,
the agent never needs restarting when you add or edit docs.

> Access is gated by your Tailscale ACLs (tailnet-only) — no separate login. It serves the full
> local set, including private docs.

## Add or change a document

Author a doc with the skill (start from
`skill/editorial-longform-html/assets/engineering-reference.html`), then file it in:

    deno task add-doc --src /path/to/your-doc.html --topic <topic-id> \
      --title "Title" --kind "Guide · Engineering Ref" --desc "One line." \
      --foot-left "2026·06·07" --foot-right "repo-or-source"

Or edit `registry.jsonc` (topics → docs) by hand and refresh — that's it. Each doc points at a `src`
HTML (relative to this repo's parent directory, so docs can live in sibling repos); if
`_migrated/<slug>.html` exists it's used instead. Flags:

- `visibility`: `private` | `shared` — `deno task publish` ships only the `shared` subset; the local
  server ignores it (shows everything).
- `review`: `true` — surfaces the doc in a pinned **For Review** section at the top of the index,
  with a chip on its card.

## Manage from the browser

The live server is also the management surface (the static publish never carries any of this):

- **Index → § Manage** (bottom-left) reveals per-card controls: toggle `review`, flip
  `private`/`shared`, or `remove` (two-step confirm). Removal only deregisters the doc — the
  `_migrated/` copy and any annotations stay on disk, so re-adding the same slug restores them.
- **Doc pages** get a breadcrumb cluster: the review chip ("mark for review" / "▸ in review —
  promote") and a `§ n` annotation count.
- Set `READONLY=1` to serve a view-only instance (mutation routes return 403, management UI hidden)
  — handy if an exposure should be look-don't-touch.

## Annotations

Select a passage on any doc page → **§ annotate** → write a note. Only the document's content is
annotatable — masthead, minimap/TOC, and footer are not. Notes are anchored to the text (quote +
context, W3C-annotation style) and shown as copper `§` marks in a consistent gutter right of the
column; click one to read, jump, mark reviewed, or delete (deletes always ask to confirm). Click the
`§ n` counter to lay every note out in the margin at once — overlapping anchors stack downward — and
click it again to return to marks. Marking a note `✓` reviewed retires it from the margin; a `✓ n`
counter appears beside `§ n` to toggle reviewed notes back into view, muted. If a doc is re-authored
and a quote disappears (or becomes ambiguous), the note survives as "unanchored" in the `§ n` list.
Storage is `comments/<slug>.json` sidecars — source HTML is never modified, and annotations never
appear in the static build. Creating annotations is selection-driven and desktop-first; reading them
works anywhere.

## Dark mode

A warm "espresso" dark theme is injected into every page. The toggle (bottom-right) persists your
choice and defaults to your system setting.

## Customize

Site title, masthead eyebrow, lede, and footer live in the `SITE` constant at the top of `render.ts`
— edit to taste.

## Layout

- `registry.jsonc` — **the site structure** (topics + docs). Edit this.
- `render.ts` — shared rendering core (index + per-doc transform: nav, zoom, theme, link rewrite).
  Used by both serve and build.
- `serve.ts` — local server (127.0.0.1:8413); renders **dynamically** per request.
- `build.ts` — writes the **same** output to static files, for publish.
- `publish.ts` — build the shared subset to `.publish/` + run the configured push command.
- `registry-edit.ts` — pure registry string surgery (used by add-doc and the management API).
- `comments.ts`, `comments/` — annotation store: one JSON sidecar per doc slug.
- `admin.ts`, `assets/admin/` — the serve-only management layer (manage mode, review chip,
  marginalia). Never part of static output.
- `add-doc.ts` — register (and place in `_migrated/`) a standalone doc.
- `agent.sh` — install/manage the LaunchAgent + Tailscale HTTPS exposure (macOS).
- `assets/editorial/` — the canonical zoom + theme + mobile bundle, injected into every served page
  (and inlined in the skill template; `drift_test.ts` pins the two together).
- `favicon.svg`, `apple-touch-icon.png` — site icons (copper § on forest); served at `/`, linked
  into every page, part of publish.
- `deno.jsonc` — tasks (`serve`, `build`, `publish`, `add-doc`, `test`).
- `_migrated/` — editorial HTML copies / hand-authored docs (NOT wiped).
- `docs/`, `index.html` — generated by `deno task build` (publish artifact); the live server does
  not use them. Wiped each build.
- `skill/editorial-longform-html/` — the authoring skill (template + style guide).

## Remote sharing

`deno task publish` builds the **`visibility: shared` subset** into `.publish/` and, if
`publish.jsonc` exists, hands it to your command:

    { "cmd": ["aws", "s3", "sync", "{out}", "s3://my-bucket", "--delete"] }

`{out}` is replaced with the absolute `.publish/` path; `--dry-run` previews the command without
running it. No config → it builds and tells you where the files are. Put the result behind whatever
auth your setup provides. Two sharp edges: links from shared docs to private docs are not rewritten
(they'd be dead remotely), and publishing with nothing shared pushes an empty site (the CLI warns
when the subset is empty).

> URLs are extensionless (`/docs/<slug>`, not `…/<slug>.html`) and links are absolute-from-root. The
> dynamic server serves `/docs/<slug>` directly (and 301-redirects legacy `…/<slug>.html`);
> `build.ts` writes each doc as `docs/<slug>/index.html`, so S3-style hosts resolve `/docs/<slug>`
> to its index document with no rewrite function. Both forms hit the same absolute links.
