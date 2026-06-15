# Per-Instance Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** Each instance has a name (`site.jsonc` `instance`, else the bare hostname) shown
serve-only as an eyebrow tag (`REFERENCE LIBRARY · STUDIO`) and advertised by
`/.well-known/reading-room.json` so the library switcher shows distinct names. Dropped from static
builds.

**Architecture:** `resolveInstanceName(site, hostnameFn)` in `config.ts` (injectable hostname for
tests). `renderIndex` gains an optional `instanceName` (build omits it → purity by signature). The
discovery `PeerIdentity` changes `title` → `name`; `serve.ts` wires the resolved name into both the
index masthead and the identity endpoint. Serve gains `--allow-sys=hostname`.

**Tech Stack:** Deno 2.x, TS (no `any`), JSR std. Tests colocated `src/<name>_test.ts`. Lands on
`worktree-peer-discovery`.

**Reference spec:** `_specs/2026-06-15-instance-name-design.md`.

**Conventions:** no `any`; smallest changes; match style; no AI/Claude in commits;
`deno fmt`/`deno lint` before each commit; explicit return types on exports.

---

## Task ordering

T1 config (`resolveInstanceName`) → T2 render (`instanceName` arg) → T3 discovery identity `name` +
serve wiring (combined, to keep the suite compiling) → T4 switcher asset → T5 `deno.jsonc` perms →
T6 docs → T7 verify. Sequential.

---

## Task 1: `instance` field + `resolveInstanceName`

**Files:** Modify `src/config.ts`; Test `src/config_test.ts`.

- [ ] **Step 1: Failing tests** — append to `src/config_test.ts`:

```ts
Deno.test("parseSite accepts a string instance", () => {
  const s = parseSite({ instance: "Studio" });
  assertEquals(typeof s === "string" ? s : s.instance, "Studio");
});

Deno.test("parseSite rejects a non-string instance", () => {
  assertEquals(parseSite({ instance: 5 }), "instance must be a string");
});

Deno.test("resolveInstanceName prefers site.instance", () => {
  assertEquals(
    resolveInstanceName({ ...DEFAULT_SITE, instance: "Studio" }, () => "m4mini.local"),
    "Studio",
  );
});

Deno.test("resolveInstanceName falls back to the bare hostname", () => {
  assertEquals(resolveInstanceName(DEFAULT_SITE, () => "m4mini.local"), "m4mini");
});

Deno.test("resolveInstanceName treats a blank instance as unset", () => {
  assertEquals(
    resolveInstanceName({ ...DEFAULT_SITE, instance: "  " }, () => "host.example"),
    "host",
  );
});
```

Merge `resolveInstanceName` and `DEFAULT_SITE` into the existing `./src/config.ts` import if not
already present.

- [ ] **Step 2: Run — FAIL**

Run: `deno test --allow-read --allow-write --allow-env src/config_test.ts` Expected: FAIL
(`instance` rejected as unknown field; `resolveInstanceName` not exported).

- [ ] **Step 3: Implement.** In `src/config.ts`:

Add to `Site` (after `footer`):

```ts
instance?: string; // this instance's name; serve-only, advertised to peers. Unset → bare hostname.
```

In `parseSite`, add a branch before the `unknown field` `else` (next to the `seeds` branch):

```ts
} else if (key === "instance") {
  if (typeof o.instance !== "string") return "instance must be a string";
  site.instance = o.instance;
} else if (key === "seeds") {
```

(Insert the `instance` branch immediately before the existing `seeds` branch.)

Add the resolver (after `resolveHome` or near the bottom):

```ts
/** The name this instance advertises and shows: site.instance if a non-empty
 * string, else the bare hostname (first dot-label). hostnameFn is injectable
 * so tests never call the real Deno.hostname(). Serve-only — build never calls
 * this, so the build needs no --allow-sys and never learns the name. */
export function resolveInstanceName(site: Site, hostnameFn: () => string = Deno.hostname): string {
  const explicit = site.instance?.trim();
  if (explicit) return explicit;
  return hostnameFn().split(".")[0];
}
```

- [ ] **Step 4: Run — PASS**

Run: `deno test --allow-read --allow-write --allow-env src/config_test.ts` Expected: PASS.

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/config.ts src/config_test.ts && deno lint src/config.ts src/config_test.ts
git add src/config.ts src/config_test.ts
git commit -m "feat(config): site.jsonc instance name + resolveInstanceName"
```

---

## Task 2: `renderIndex` instance-name eyebrow tag

**Files:** Modify `src/render.ts`; Test `src/render_test.ts`.

- [ ] **Step 1: Failing tests** — append to `src/render_test.ts`:

```ts
Deno.test("renderIndex tags the eyebrow with the instance name when given", () => {
  const html = renderIndex(DEFAULT_SITE, [], "Studio");
  assertStringIncludes(html, `<div class="eyebrow">${DEFAULT_SITE.eyebrow} · Studio</div>`);
});

Deno.test("renderIndex omits the instance tag with no name (build purity)", () => {
  const html = renderIndex(DEFAULT_SITE, []);
  assertStringIncludes(html, `<div class="eyebrow">${DEFAULT_SITE.eyebrow}</div>`);
});
```

Merge `renderIndex`, `DEFAULT_SITE`, `assertStringIncludes` into existing imports as needed
(`DEFAULT_SITE` is from `./src/config.ts`).

- [ ] **Step 2: Run — FAIL**

Run: `deno test --allow-read --allow-write --allow-env src/render_test.ts` Expected: FAIL — the
first test fails (no instance tag rendered).

- [ ] **Step 3: Implement.** In `src/render.ts`:

Change `indexTemplate` signature:

```ts
function indexTemplate(site: Site, instanceName?: string): string {
```

Change the eyebrow line (currently `<div class="eyebrow">${site.eyebrow}</div>`) to:

```ts
<div class="eyebrow">${site.eyebrow}${instanceName ? ` · ${instanceName}` : ""}</div>;
```

Change `renderIndex` signature and pass the name through:

```ts
export function renderIndex(site: Site, corpus: Topic[], instanceName?: string): string {
```

and in its body change `indexTemplate(site)` to `indexTemplate(site, instanceName)`.

- [ ] **Step 4: Run — PASS**

Run: `deno test --allow-read --allow-write --allow-env src/render_test.ts` Expected: PASS (new +
existing render tests; existing two-arg `renderIndex` callers unaffected).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/render.ts src/render_test.ts && deno lint src/render.ts src/render_test.ts
git add src/render.ts src/render_test.ts
git commit -m "feat(render): serve-only instance-name eyebrow tag"
```

---

## Task 3: discovery identity `name` + serve wiring

Combined so the suite keeps compiling (the `PeerIdentity` change ripples into `serve.ts`).

**Files:** Modify `src/discovery.ts`, `src/discovery_test.ts`, `src/serve.ts`, `src/serve_test.ts`.

- [ ] **Step 1: Update discovery_test + serve_test fixtures and add serve assertions.**

In `src/discovery_test.ts`, replace every `PeerIdentity` literal's `title:` with `name:` and update
`buildIdentity`'s call/expectation. Concretely:

- `buildIdentity` test → `buildIdentity("Studio", corpus, "9.9.9")` expecting
  `{ name: "Studio", version: "9.9.9", topics: 2, docs: 3 }`.
- `probePeer` "good" identity → `{ name: "Studio", version: "0.2.0", topics: 2, docs: 5 }`.
- `discoverPeers` `idents` values → use `name` instead of `title`.
- `makeCachedDiscover` probe → `{ name: "S", version: "0.2.0", topics: 0, docs: 0 }`.
- the no-slash-seed dedup test's probe identity → `{ name: "Studio", ... }`. Add a
  probe-rejects-missing-name test:

```ts
Deno.test("probePeer rejects a response missing name", async () => {
  const bad = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ version: "0.2.0", topics: 0, docs: 0 })),
    )) as typeof fetch;
  assertEquals(await probePeer("https://x.ts.net/", bad), null);
});
```

In `src/serve_test.ts`:

- In `tmpCtx`, also write a `site.jsonc` so the masthead assertion is deterministic and avoids the
  hostname call:

```ts
await Deno.writeTextFile(join(home, "site.jsonc"), '{ "instance": "Test Room" }\n');
```

- In the identity test, change `assertEquals(typeof body.title, "string")` →
  `assertEquals(body.name, "Test Room")` (and keep the topics/docs/version asserts).
- In the `/api/peers` injected-result test, change the peer `identity` literal `title:` → `name:`.
- Add a masthead-tag test:

```ts
Deno.test("served index masthead carries the instance eyebrow tag", async () => {
  const { ctx, cleanup } = await tmpCtx();
  try {
    const h = makeHandler({ ctx, readonly: false });
    const html = await (await h(new Request("http://localhost/"))).text();
    assertStringIncludes(html, "Reference Library · Test Room");
  } finally {
    await cleanup();
  }
});
```

Merge `assertStringIncludes` into serve_test imports if missing.

- [ ] **Step 2: Run — FAIL**

Run:
`deno test --allow-read --allow-write --allow-env --allow-run --allow-sys=hostname src/discovery_test.ts src/serve_test.ts`
Expected: FAIL (type errors: `PeerIdentity` has no `title`; `buildIdentity` arity; `serve` not yet
wired).

- [ ] **Step 3: Implement discovery.ts.**

- Change `PeerIdentity`:

```ts
export interface PeerIdentity {
  name: string;
  version: string;
  topics: number;
  docs: number;
}
```

- Remove the now-unused `import type { Site } from "./config.ts";` line.
- Change `buildIdentity`:

```ts
/** The identity this instance advertises at /.well-known/reading-room.json. */
export function buildIdentity(name: string, corpus: Topic[], version: string): PeerIdentity {
  return {
    name,
    version,
    topics: corpus.length,
    docs: corpus.reduce((n, t) => n + t.docs.length, 0),
  };
}
```

- Change `asIdentity` to validate `name`:

```ts
function asIdentity(raw: unknown): PeerIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.name !== "string" || typeof o.version !== "string" ||
    typeof o.topics !== "number" || typeof o.docs !== "number"
  ) return null;
  return { name: o.name, version: o.version, topics: o.topics, docs: o.docs };
}
```

- [ ] **Step 4: Implement serve.ts.**

- Add `resolveInstanceName` to the `./config.ts` import (the line importing
  `makeContext, resolveHome`).
- In the identity route, change:

```ts
const corpus = await loadCorpus(opts.ctx.registryPath);
return json(buildIdentity(opts.ctx.site, corpus, VERSION));
```

to:

```ts
const corpus = await loadCorpus(opts.ctx.registryPath);
return json(buildIdentity(resolveInstanceName(opts.ctx.site), corpus, VERSION));
```

- In the index route (`if (path === "/")`), change the `renderIndex(opts.ctx.site, corpus)` call to:

```ts
renderIndex(opts.ctx.site, corpus, resolveInstanceName(opts.ctx.site)),
```

(keep the surrounding `injectLocalSlots(... , await loadSlots(opts.ctx.root))`).

- [ ] **Step 5: Run — PASS**

Run:
`deno test --allow-read --allow-write --allow-env --allow-run --allow-sys=hostname src/discovery_test.ts src/serve_test.ts`
Expected: PASS. Confirm no pre-existing test regressed.

- [ ] **Step 6: fmt + lint + commit**

```bash
deno fmt src/discovery.ts src/discovery_test.ts src/serve.ts src/serve_test.ts
deno lint src/discovery.ts src/discovery_test.ts src/serve.ts src/serve_test.ts
git add src/discovery.ts src/discovery_test.ts src/serve.ts src/serve_test.ts
git commit -m "feat(discovery,serve): identity advertises instance name; masthead tag"
```

---

## Task 4: switcher shows `identity.name`

**Files:** Modify `assets/admin/admin.js`; regenerate `src/assets_gen.ts`.

- [ ] **Step 1: Edit `assets/admin/admin.js`.** In `initSwitcher`, change the option label line
      from:

```js
const opt = el("option", null, (p.identity && p.identity.title) || p.name || p.url);
```

to:

```js
const opt = el("option", null, (p.identity && p.identity.name) || p.name || p.url);
```

- [ ] **Step 2: Regenerate**

Run: `deno task gen` Then `git status --short` — expect only `assets/admin/admin.js` and
`src/assets_gen.ts` changed (NOT `src/version.ts`); if version.ts changed, STOP and report.

- [ ] **Step 3: Verify pin**

Run:
`deno test --allow-read --allow-write --allow-env --allow-run --allow-sys=hostname src/assets_gen_test.ts`
Expected: PASS.

- [ ] **Step 4: commit**

```bash
git add assets/admin/admin.js src/assets_gen.ts
git commit -m "feat(admin): switcher shows peer instance name"
```

---

## Task 5: serve/cli gain `--allow-sys=hostname`

**Files:** Modify `deno.jsonc`.

- [ ] **Step 1: Edit `deno.jsonc`.**

Add `--allow-sys=hostname` to the `serve` and `cli` task command strings, and to the `test` task.
Concretely:

- `serve`: insert `--allow-sys=hostname` (e.g. after `--allow-run`).
- `cli`: insert `--allow-sys=hostname` (after `--allow-run`).
- `test`: change `"deno test --allow-read --allow-write --allow-env"` to
  `"deno test --allow-read --allow-write --allow-env --allow-run --allow-sys=hostname"` (the suite
  now needs run + sys for serve/discovery tests).

- [ ] **Step 2: Verify the suite via the task**

Run: `deno task test 2>&1 | tail -2` Expected: all tests pass.

- [ ] **Step 3: fmt + commit**

```bash
deno fmt deno.jsonc
git add deno.jsonc
git commit -m "chore(serve): grant --allow-sys=hostname for the instance-name fallback"
```

---

## Task 6: docs

**Files:** Modify `README.md`, `CLAUDE.md`. Prose only; verify with `deno fmt --check`.

- [ ] **Step 1: `CLAUDE.md`** — in the "Peer discovery (serve-only)" section (or near it), note:
      each instance has a name — `site.jsonc` `instance`, else the bare hostname — shown serve-only
      as an eyebrow tag (`REFERENCE LIBRARY · NAME`, dropped from builds) and advertised as `name`
      in `/.well-known/reading-room.json` (what the switcher displays). Note serve now needs
      `--allow-sys=hostname` (in the installed-CLI union) for the hostname fallback. If there is an
      installed-CLI permission line, update the union to include `--allow-sys=hostname`.

- [ ] **Step 2: `README.md`** — in the discovery/serve area, add a sentence: set `instance` in
      `site.jsonc` (e.g. `"instance": "Studio"`) to name a machine's library; it shows in the
      masthead and the switcher, and defaults to the hostname.

- [ ] **Step 3: Verify + commit**

```bash
deno fmt CLAUDE.md README.md && deno fmt --check CLAUDE.md README.md
git add CLAUDE.md README.md
git commit -m "docs: per-instance name + --allow-sys note"
```

---

## Task 7: full verification

- [ ] **Step 1: Full gate**

```bash
deno fmt --check
deno lint
deno test --allow-read --allow-write --allow-env --allow-run --allow-sys=hostname
deno publish --dry-run --allow-dirty
```

Expected: all pass; dry-run ships `discovery.ts`, 0 test files.

- [ ] **Step 2: End-to-end** against a throwaway home (proves serve tag + identity name + build
      purity):

```bash
TMP=$(mktemp -d)
deno run -A src/cli.ts init --root "$TMP"
printf '{ "instance": "Throwaway" }\n' > "$TMP/site.jsonc"
deno run --allow-read --allow-write --allow-net --allow-run --allow-sys=hostname src/serve.ts --root "$TMP" --port 8533 >/tmp/rr3.out 2>&1 &
SRV=$!; sleep 2
echo "identity:"; curl -s http://127.0.0.1:8533/.well-known/reading-room.json; echo
echo "masthead tag:"; curl -s http://127.0.0.1:8533/ | grep -o 'class="eyebrow">[^<]*' | head -1
kill $SRV 2>/dev/null
# build must NOT contain the instance tag
deno run -A src/cli.ts build --root "$TMP" >/dev/null 2>&1
echo "build eyebrow (no instance):"; grep -o 'class="eyebrow">[^<]*' "$TMP/index.html" | head -1
rm -rf "$TMP"
```

Expected: identity JSON has `"name":"Throwaway"`; served masthead eyebrow shows
`Reference Library · Throwaway`; the built `index.html` eyebrow shows `Reference Library` with
**no** `· Throwaway`.

- [ ] **Step 3: Report** pass/fail of each.

---

## Self-review notes (author)

- **Coverage:** config field+resolver (T1), eyebrow tag (T2), identity `name`+serve wiring+masthead
  (T3), switcher (T4), perms (T5), docs (T6), gate+e2e (T7).
- **Build purity:** `build.ts` keeps the two-arg `renderIndex` (no instance) — pinned by T2's
  no-name test and T7's build check.
- **Type consistency:** `PeerIdentity.name` everywhere (discovery, tests, serve, switcher);
  `buildIdentity(name, corpus, version)` matches its only caller (serve) and the test;
  `resolveInstanceName(site, hostnameFn?)` signature matches T1 tests and the T3 serve calls.
- **Permissions:** only serve/cli/test gain `--allow-sys=hostname`; build/add-doc/publish unchanged.
