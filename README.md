# Reading Room

An editorial document library **engine**, published to JSR as
[`@tlockney/reading-room`](https://jsr.io/@tlockney/reading-room), plus the
**editorial-longform-html** authoring skill that produces the documents it serves. Tooling is Deno —
no build step.

The engine serves, builds, publishes, and annotates a registry of long-form HTML documents. Each
machine has a **content home** — a plain local directory — that holds only its own content and
identity; features land once here and every machine picks them up with a CLI upgrade.

Three pieces, one visual language:

- **The engine** (`src/`) — rendering core, live server with management API, static builder, remote
  publisher.
- **The skill** (`skill/editorial-longform-html/`) — a Claude Code skill for authoring documents in
  the editorial-print aesthetic: cream paper, Fraunces + Source Serif + JetBrains Mono,
  forest/copper accents, numbered sections. Install it by copying (or symlinking) the directory into
  `~/.claude/skills/`:

      ln -s "$(pwd)/skill/editorial-longform-html" ~/.claude/skills/

- **The content** — `registry.jsonc` + `_migrated/` + `comments/`. This repo carries its own content
  for development; each machine keeps its content in the resolved content home.

## Install

```sh
deno install -g -f -n reading-room \
  --allow-read --allow-write --allow-net --allow-run \
  --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME \
  --minimum-dependency-age=0 \
  jsr:@tlockney/reading-room/cli

reading-room init        # scaffold the content home
reading-room serve       # serve it on 127.0.0.1:8413
```

The content home is `--root`, else `$READING_ROOM_HOME`, else
`${XDG_DATA_HOME:-~/.local/share}/reading-room`. No install? Use the fallback:
`deno run -A jsr:@tlockney/reading-room/cli <subcommand>`.

## A content home

A plain local directory — no git, no sync. `reading-room init` scaffolds it; write commands lazily
create missing structure. The layout:

    site.jsonc          # site identity (title, eyebrow, lede, footer) — optional
    registry.jsonc      # the corpus: topics → docs
    _migrated/          # the documents
    comments/           # annotation sidecars (created on first annotation)
    assets/head-extra.html   # optional: local <head> additions (CSS, fonts…)
    assets/body-extra.html   # optional: local <body> additions
    publish.jsonc       # optional: remote-publish command

## Use it

    reading-room serve           # serve on 127.0.0.1:8413 — rendered live, no build step
    PORT=9000 reading-room serve # …a different port

    reading-room build           # write static files (only needed to publish)
    reading-room publish         # build the shared subset + run publish.jsonc's command

`reading-room serve` renders every page on the fly from `registry.jsonc` and the source docs, bound
to **localhost only**. Editing the registry or any doc shows up on the next refresh — no rebuild, no
restart. It also carries the management layer — review toggles, visibility, removal, and annotations
— which exists only on the live server, never in published output.

## Always-on, over Tailscale (optional)

A macOS launchd agent running `reading-room serve` (starts at login, auto-restarts via `KeepAlive`)
with `tailscale serve` fronting it at `https://<your-machine>.<your-tailnet>.ts.net/` — reachable
only from your tailnet, over HTTPS, with no raw LAN exposure. Because serving is dynamic, the agent
never needs restarting when you add or edit docs. The agent does not need a `WorkingDirectory` —
`reading-room serve` resolves the content home internally.

> Access is gated by your Tailscale ACLs (tailnet-only) — no separate login. It serves the full
> local set, including private docs.

## Add or change a document

Author a doc with the skill (start from
`skill/editorial-longform-html/assets/engineering-reference.html`), then file it in:

    reading-room add-doc --src /path/to/your-doc.html --topic <topic-id> \
      --title "Title" --kind "Guide · Engineering Ref" --desc "One line." \
      --foot-left "2026·06·07" --foot-right "repo-or-source"

Or edit `registry.jsonc` (topics → docs) by hand and refresh — that's it. Each doc's
`_migrated/<slug>.html` is the self-contained source; the registry's `src` field is vestigial and
not relied upon. Flags:

- `visibility`: `private` | `shared` — `reading-room publish` ships only the `shared` subset; the
  local server ignores it (shows everything).
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

## Customize an environment

- **Identity** — `site.jsonc` in the content repo sets the `<title>`, masthead eyebrow, lede, and
  footer lines. Every field is optional; absent file means the generic defaults.
- **Local additions** — `assets/head-extra.html` and `assets/body-extra.html` are injected into
  every page (served _and_ built) inside `RR-LOCAL-HEAD` / `RR-LOCAL-BODY` marked regions:
  idempotent, healing, and **additive only**. The canonical editorial bundle always injects
  regardless — there is no override mechanism, so the skill-drift guarantee holds in every
  environment.

## Engine development (this repo)

    deno task test               # full suite: render, surgery, comments, API, purity, drift
    deno task gen                # regenerate src/assets_gen.ts after editing assets/

Layout:

- `src/render.ts` — shared rendering core (index + per-doc transform: nav, zoom, theme, link
  rewrite, local slots). Used by both serve and build.
- `src/serve.ts` — local server (127.0.0.1:8413); renders **dynamically** per request; carries the
  management API (`/api/docs/…`).
- `src/build.ts` — writes the **same** output to static files, for publish.
- `src/publish.ts` — build the shared subset to `.publish/` + run the configured push command.
- `src/add-doc.ts` — register (and place in `_migrated/`) a standalone doc.
- `src/registry-edit.ts` — pure registry string surgery (used by add-doc and the management API).
- `src/comments.ts` — annotation store: one JSON sidecar per doc slug.
- `src/admin.ts` — the serve-only management layer injection. Never part of static output.
- `src/config.ts` — `site.jsonc` loading + the `RoomContext` (content root, derived paths).
- `src/assets_gen.ts` — GENERATED (`deno task gen`): the editorial partials, admin bundle, and site
  icons embedded as strings so the package never reads package-relative files.
- `src/mod.ts` — the library surface (also exports `EDITORIAL_HEAD`/`EDITORIAL_BODY` for
  content-home drift tests).
- `assets/editorial/` — the canonical zoom + theme + mobile bundle **source** (inlined in the skill
  template; `drift_test.ts` pins the two together).
- `assets/admin/` — the management UI bundle source (manage mode, review chip, marginalia).
- `scripts/gen-assets.ts` — the embedding codegen (`assets_gen_test.ts` pins output ↔ source).
- `example/` — a minimal consumer content repo, exercised by `example_test.ts`.
- `skill/editorial-longform-html/` — the authoring skill (template + style guide).
- `registry.jsonc`, `_migrated/`, `comments/` — this repo's own content (it is its own first
  consumer; `deno task …` here operates on the repo root).
- `docs/`, `index.html` — generated by `deno task build` (publish artifact); the live server does
  not use them. Wiped each build.

Releasing: bump `version` in `deno.jsonc`, tag `v<version>`, push the tag — the `publish` workflow
tests and runs `deno publish` (JSR OIDC, no token).

## Remote sharing

`reading-room publish` builds the **`visibility: shared` subset** into `.publish/` and, if
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
