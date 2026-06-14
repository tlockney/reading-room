# Content Home + CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Reading Room engine into an installable `reading-room` CLI that operates on a single well-known per-machine content home (`--root` → `$READING_ROOM_HOME` → `${XDG_DATA_HOME:-~/.local/share}/reading-room`) instead of per-host content repos rooted at `Deno.cwd()`.

**Architecture:** Keep the root-agnostic library API (`makeContext(root)`); add a `resolveHome()` resolver and lift each entry point's `import.meta.main` block into an exported `*Main(args)` function that resolves the home and returns an exit code. A new `src/cli.ts` dispatches `serve|build|add-doc|publish|init` plus `--help`/`--version`. A generated `src/version.ts` surfaces the version (the package omits `deno.jsonc`). `init` + a lazy `ensureHome()` bootstrap a fresh home.

**Tech Stack:** Deno 2.x, TypeScript (no `any`), JSR (`@std/path`, `@std/fs`, `@std/jsonc`, `@std/cli`), `deno test`.

**Reference specs:** `_specs/2026-06-13-content-home-design.md` (this work) and `_specs/2026-06-13-cli-distribution-design.md` (the dispatcher it amends).

**Conventions:** Tests live at repo ROOT as `<name>_test.ts`, run with `deno test --allow-read --allow-write --allow-env`. Never use `any`. Never mention AI/Claude in commit messages. Keep changes minimal and match surrounding style. Run `deno fmt --check` and `deno lint` before each commit (CI enforces them).

---

## Task ordering / parallelism

- **Wave 1 (independent leaves):** Task 1 (`resolveHome`), Task 2 (`version.ts`), Task 3 (`insertTopic` empty-array fix). Different files; safe to run concurrently.
- **Wave 2 (need `resolveHome`):** Task 4 (`init`/`ensureHome`, also needs Task 3), Task 5 (`buildMain`), Task 6 (`serveMain`), Task 8 (`publishMain`).
- **Wave 3:** Task 7 (`addDocMain`, needs `ensureHome` from Task 4).
- **Wave 4:** Task 9 (`cli.ts`, needs Tasks 2,4,5,6,7,8).
- **Wave 5:** Task 10 (`deno.jsonc`), then Task 11 (docs), then Task 12 (final verification).

---

## Task 1: `resolveHome()` in config.ts

**Files:**
- Modify: `src/config.ts` (add exported function; `dirname, join, resolve` are already imported)
- Test: `config_test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `config_test.ts`:

```ts
import { resolveHome } from "./src/config.ts";
import { join, resolve } from "jsr:@std/path@1";

Deno.test("resolveHome: --root flag wins over env", () => {
  Deno.env.set("READING_ROOM_HOME", "/from/env");
  try {
    assertEquals(resolveHome("/from/flag"), resolve("/from/flag"));
  } finally {
    Deno.env.delete("READING_ROOM_HOME");
  }
});

Deno.test("resolveHome: READING_ROOM_HOME used when no flag", () => {
  Deno.env.set("READING_ROOM_HOME", "/srv/rr");
  try {
    assertEquals(resolveHome(), resolve("/srv/rr"));
  } finally {
    Deno.env.delete("READING_ROOM_HOME");
  }
});

Deno.test("resolveHome: XDG_DATA_HOME default when no flag/env", () => {
  Deno.env.delete("READING_ROOM_HOME");
  Deno.env.set("XDG_DATA_HOME", "/xdg");
  try {
    assertEquals(resolveHome(), join("/xdg", "reading-room"));
  } finally {
    Deno.env.delete("XDG_DATA_HOME");
  }
});

Deno.test("resolveHome: falls back to ~/.local/share/reading-room", () => {
  Deno.env.delete("READING_ROOM_HOME");
  Deno.env.delete("XDG_DATA_HOME");
  const savedHome = Deno.env.get("HOME");
  Deno.env.set("HOME", "/home/tester");
  try {
    assertEquals(resolveHome(), join("/home/tester", ".local", "share", "reading-room"));
  } finally {
    if (savedHome !== undefined) Deno.env.set("HOME", savedHome);
  }
});
```

(If `config_test.ts` already imports `assertEquals` and/or `join`/`resolve`, do not duplicate the import — merge into the existing import lines.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env config_test.ts`
Expected: FAIL — `resolveHome` is not exported.

- [ ] **Step 3: Implement `resolveHome`** — add to `src/config.ts` (after `makeContext`):

```ts
/** Resolve the content home the CLI operates on: an explicit --root flag, else
 * $READING_ROOM_HOME, else ${XDG_DATA_HOME:-~/.local/share}/reading-room. The
 * library API (makeContext) stays root-agnostic; only the CLI uses this. */
export function resolveHome(flagRoot?: string): string {
  if (flagRoot) return resolve(flagRoot);
  const env = Deno.env.get("READING_ROOM_HOME");
  if (env) return resolve(env);
  const xdg = Deno.env.get("XDG_DATA_HOME") ??
    join(Deno.env.get("HOME") ?? ".", ".local", "share");
  return join(xdg, "reading-room");
}
```

Also update the file header comment block (lines 1-7) note "normally Deno.cwd()" to mention the CLI resolves the home via `resolveHome` — keep it to one added clause; do not rewrite the comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env config_test.ts`
Expected: PASS (all resolveHome tests + existing config tests).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/config.ts config_test.ts && deno lint src/config.ts config_test.ts
git add src/config.ts config_test.ts
git commit -m "feat(config): resolveHome — CLI content-home resolution"
```

---

## Task 2: generated `src/version.ts` + pin test

**Files:**
- Modify: `scripts/gen-assets.ts` (add version generation; emit `src/version.ts` in `import.meta.main`)
- Create: `src/version.ts` (generated)
- Create: `version_test.ts` (pin)

- [ ] **Step 1: Write the failing pin test** — create `version_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { VERSION } from "./src/version.ts";

Deno.test("version.ts VERSION matches deno.jsonc version", async () => {
  const cfg = parseJsonc(await Deno.readTextFile("deno.jsonc")) as { version: string };
  assertEquals(VERSION, cfg.version);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read version_test.ts`
Expected: FAIL — `./src/version.ts` does not exist.

- [ ] **Step 3: Extend the generator** — in `scripts/gen-assets.ts`:

Add an import near the top (after the existing imports):

```ts
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
```

Add this exported function (after `generate`):

```ts
export async function generateVersion(root: string = REPO): Promise<string> {
  const cfg = parseJsonc(await Deno.readTextFile(join(root, "deno.jsonc"))) as { version: string };
  return `// GENERATED by scripts/gen-assets.ts — do not edit. Run: deno task gen\n` +
    `export const VERSION: string = ${JSON.stringify(cfg.version)};\n`;
}
```

Extend the `import.meta.main` block to also write version.ts:

```ts
if (import.meta.main) {
  await Deno.writeTextFile(join(REPO, "src/assets_gen.ts"), await generate());
  console.log("wrote src/assets_gen.ts");
  await Deno.writeTextFile(join(REPO, "src/version.ts"), await generateVersion());
  console.log("wrote src/version.ts");
}
```

- [ ] **Step 4: Generate version.ts and verify the test passes**

Run: `deno task gen && deno test --allow-read version_test.ts`
Expected: writes `src/version.ts` and `src/assets_gen.ts`; test PASSES. (`src/version.ts` should read `export const VERSION: string = "0.1.1";` until Task 10 bumps it.)

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt scripts/gen-assets.ts src/version.ts version_test.ts
deno lint scripts/gen-assets.ts src/version.ts version_test.ts
git add scripts/gen-assets.ts src/version.ts version_test.ts
git commit -m "feat(version): generate src/version.ts from deno.jsonc with pin test"
```

---

## Task 3: `insertTopic` handles an empty top-level array

The lazy-created/init registry is `[]`. `insertTopic` currently always prepends `,\n`, which would produce invalid `[,\n {...}]` on the first `add-doc --new-topic`. Fix it to omit the separator when the array is empty.

**Files:**
- Modify: `src/registry-edit.ts:175-188` (`insertTopic`)
- Test: `registry-edit_test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `registry-edit_test.ts`:

```ts
Deno.test("insertTopic into an empty array produces valid JSONC", () => {
  const empty = "// registry\n[]\n";
  const out = insertTopic(empty, {
    num: "§ 01",
    id: "intro",
    name: "Introduction",
    short: "Intro",
    docs: [{
      slug: "hello",
      title: "Hello",
      kind: "Reference",
      desc: "",
      footLeft: "Reference",
      footRight: "Reading Room",
      src: "reading-room/_migrated/hello.html",
      visibility: "private",
    }],
  });
  // Must parse back to exactly one topic with one doc.
  const parsed = parseJsonc(out) as Array<{ id: string; docs: Array<{ slug: string }> }>;
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].id, "intro");
  assertEquals(parsed[0].docs[0].slug, "hello");
});
```

Ensure `registry-edit_test.ts` imports `insertTopic` and `parseJsonc` (`import { parse as parseJsonc } from "jsr:@std/jsonc@1";`) — add if missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env registry-edit_test.ts`
Expected: FAIL — `parseJsonc(out)` throws on the leading comma `[,`.

- [ ] **Step 3: Fix `insertTopic`** — replace the body of `insertTopic` in `src/registry-edit.ts`:

```ts
/** Append a new topic (with its docs) before the top-level closing `]`. */
export function insertTopic(registry: string, topic: TopicEntry): string {
  for (const d of topic.docs) {
    if (slugExists(registry, d.slug)) throw new Error(`duplicate slug: ${d.slug}`);
  }
  const lastClose = registry.lastIndexOf("]");
  if (lastClose === -1) throw new Error("registry is not a JSON array");
  const isEmpty = (parseJsonc(registry) as unknown[]).length === 0;
  const before = registry.slice(0, lastClose).replace(/\s*$/, "");
  const docs = topic.docs.map((d) => formatDoc(d, "      ")).join(",\n");
  const lead = isEmpty ? "\n" : ",\n";
  const block = `${lead}  {\n    "num": ${JSON.stringify(topic.num)}, "id": ${
    JSON.stringify(topic.id)
  },\n` +
    `    "name": ${JSON.stringify(topic.name)}, "short": ${JSON.stringify(topic.short)},\n` +
    `    "docs": [\n${docs}\n    ]\n  }\n`;
  return before + block + registry.slice(lastClose);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env registry-edit_test.ts`
Expected: PASS — the new test AND every existing registry-edit test (non-empty insert still gets the `,\n` separator).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/registry-edit.ts registry-edit_test.ts
deno lint src/registry-edit.ts registry-edit_test.ts
git add src/registry-edit.ts registry-edit_test.ts
git commit -m "fix(registry): insertTopic handles an empty top-level array"
```

---

## Task 4: `src/init.ts` — `ensureHome` + `initMain`

**Files:**
- Create: `src/init.ts`
- Test: `init_test.ts`
- Depends on: Task 1 (`resolveHome`), Task 3 (empty-array `insertTopic`)

- [ ] **Step 1: Write failing tests** — create `init_test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { ensureHome, initMain } from "./src/init.ts";

Deno.test("ensureHome creates dirs and an empty registry", async () => {
  const home = await Deno.makeTempDir();
  try {
    await ensureHome(home);
    assert(await exists(join(home, "_migrated")));
    assert(await exists(join(home, "comments")));
    assert(await exists(join(home, "registry.jsonc")));
    // No site.jsonc — identity stays DEFAULT_SITE under lazy create.
    assertEquals(await exists(join(home, "site.jsonc")), false);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("ensureHome does not clobber an existing registry", async () => {
  const home = await Deno.makeTempDir();
  try {
    const reg = join(home, "registry.jsonc");
    await Deno.writeTextFile(reg, "// mine\n[]\n");
    await ensureHome(home);
    assertEquals(await Deno.readTextFile(reg), "// mine\n[]\n");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("initMain scaffolds a home with a site.jsonc template and returns 0", async () => {
  const home = await Deno.makeTempDir();
  try {
    const code = await initMain(["--root", home]);
    assertEquals(code, 0);
    assert(await exists(join(home, "site.jsonc")));
    assert(await exists(join(home, "registry.jsonc")));
    assert(await exists(join(home, "_migrated")));
    assert(await exists(join(home, "comments")));
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("initMain is idempotent and never clobbers site.jsonc", async () => {
  const home = await Deno.makeTempDir();
  try {
    await initMain(["--root", home]);
    await Deno.writeTextFile(join(home, "site.jsonc"), '{ "title": "Mine" }\n');
    await initMain(["--root", home]);
    assertEquals(await Deno.readTextFile(join(home, "site.jsonc")), '{ "title": "Mine" }\n');
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env init_test.ts`
Expected: FAIL — `./src/init.ts` does not exist.

- [ ] **Step 3: Implement `src/init.ts`:**

```ts
/**
 * Bootstrap a content home. `ensureHome` lazily creates the directory layout +
 * an empty registry so write paths (add-doc, annotations) never hard-fail on a
 * fresh machine; `initMain` is the guided `reading-room init` that additionally
 * writes a commented site.jsonc template. Both are idempotent and never clobber
 * existing files.
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { ensureDir, exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { resolveHome } from "./config.ts";

/** Empty registry: a top-level JSON array. insertTopic/insertDoc edit it as text. */
const EMPTY_REGISTRY = "// Reading Room registry — topics → docs.\n" +
  "// Add documents with `reading-room add-doc`.\n[]\n";

/** Commented starter identity; every field optional (absent → DEFAULT_SITE). */
const SITE_TEMPLATE = `// Reading Room site identity. Every field is optional.
{
  // "title": "The Reading Room",
  // "eyebrow": "Reference Library",
  // "lede": "Every long-form document, gathered and grouped.",
  // "footer": ["Reference Library", "Local · Not for Distribution", "The Reading Room"]
}
`;

/** Create the home layout + an empty registry if missing. Safe to call on every write. */
export async function ensureHome(home: string): Promise<void> {
  await ensureDir(home);
  await ensureDir(join(home, "_migrated"));
  await ensureDir(join(home, "comments"));
  const registry = join(home, "registry.jsonc");
  if (!(await exists(registry))) await Deno.writeTextFile(registry, EMPTY_REGISTRY);
}

/** `reading-room init [--root <dir>]` — scaffold a home, including a site.jsonc template. */
export async function initMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["root"] });
  const home = resolveHome(a.root);
  await ensureHome(home);
  const site = join(home, "site.jsonc");
  if (!(await exists(site))) await Deno.writeTextFile(site, SITE_TEMPLATE);
  console.log(`Reading Room home ready: ${home}`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await initMain(Deno.args));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env init_test.ts`
Expected: PASS (all four).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/init.ts init_test.ts && deno lint src/init.ts init_test.ts
git add src/init.ts init_test.ts
git commit -m "feat(init): ensureHome + reading-room init bootstrap"
```

---

## Task 5: lift `buildMain` in build.ts

**Files:**
- Modify: `src/build.ts:72-75` (the `import.meta.main` block) + imports
- Test: `build_test.ts` (append a `buildMain` smoke test)
- Depends on: Task 1

- [ ] **Step 1: Write the failing test** — append to `build_test.ts`:

```ts
import { buildMain } from "./src/build.ts";
import { exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";

Deno.test("buildMain --root builds index.html into the given home", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(home, "registry.jsonc"),
      '[\n  { "num": "§ 01", "id": "t", "name": "T", "short": "T", "docs": [] }\n]\n',
    );
    const code = await buildMain(["--root", home]);
    assertEquals(code, 0);
    assert(await exists(join(home, "index.html")));
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
```

Ensure `build_test.ts` imports `assert`/`assertEquals` (merge with existing import line if present).

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env build_test.ts`
Expected: FAIL — `buildMain` not exported.

- [ ] **Step 3: Implement `buildMain`** — in `src/build.ts`, add `parseArgs` + `resolveHome` imports:

```ts
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { makeContext, resolveHome } from "./config.ts";
```

(Replace the existing `import { makeContext } from "./config.ts";` line.)

Replace the `import.meta.main` block (lines 72-75) with:

```ts
export async function buildMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["root"] });
  await build(await makeContext(resolveHome(a.root)));
  console.log("Done.");
  return 0;
}

if (import.meta.main) {
  Deno.exit(await buildMain(Deno.args));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env build_test.ts`
Expected: PASS — new smoke test + existing build-purity tests.

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/build.ts build_test.ts && deno lint src/build.ts build_test.ts
git add src/build.ts build_test.ts
git commit -m "refactor(build): lift import.meta.main into buildMain(args)"
```

---

## Task 6: lift `serveMain` in serve.ts

**Files:**
- Modify: `src/serve.ts:266-291` (the `import.meta.main` block) + imports
- Test: `serve_test.ts` (append a thin `serveMain` export-shape assertion; the server itself is exercised via existing `makeHandler` tests)
- Depends on: Task 1

- [ ] **Step 1: Write the failing test** — append to `serve_test.ts`:

```ts
import { serveMain } from "./src/serve.ts";

Deno.test("serveMain is an exported function (server smoke is via makeHandler)", () => {
  assertEquals(typeof serveMain, "function");
});
```

(The live bind is intentionally not started in tests — `makeHandler` coverage in this file already exercises request handling.)

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env serve_test.ts`
Expected: FAIL — `serveMain` not exported.

- [ ] **Step 3: Implement `serveMain`** — in `src/serve.ts`, add imports:

```ts
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { makeContext, resolveHome } from "./config.ts";
```

(Merge with the existing `makeContext` import line — replace it.)

Replace the `import.meta.main` block (lines 266-291) with a `serveMain` that contains the same startup logic, then a thin guard:

```ts
export async function serveMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["root", "port"] });
  const port = Number(a.port ?? a._[0] ?? Deno.env.get("PORT") ?? 8413);
  const readonly = Deno.env.get("READONLY") === "1";
  const ctx = await makeContext(resolveHome(a.root));
  const handler = makeHandler({ ctx, readonly });

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env serve_test.ts`
Expected: PASS — new shape test + all existing handler tests.

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/serve.ts serve_test.ts && deno lint src/serve.ts serve_test.ts
git add src/serve.ts serve_test.ts
git commit -m "refactor(serve): lift import.meta.main into serveMain(args)"
```

---

## Task 7: lift `addDocMain` in add-doc.ts (home-resolved + ensureHome)

**Files:**
- Modify: `src/add-doc.ts:27-82` (the `import.meta.main` block) + imports
- Test: `add-doc_test.ts` (append an end-to-end test against a fresh home)
- Depends on: Task 1, Task 4

- [ ] **Step 1: Write the failing test** — append to `add-doc_test.ts`:

```ts
import { addDocMain } from "./src/add-doc.ts";
import { exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";

Deno.test("addDocMain files a doc into a fresh home (lazy create)", async () => {
  const home = await Deno.makeTempDir();
  const srcDir = await Deno.makeTempDir();
  try {
    const src = join(srcDir, "hello.html");
    await Deno.writeTextFile(src, "<html><body><h1>Hello</h1></body></html>");
    const code = await addDocMain([
      "--root", home,
      "--src", src,
      "--new-topic", "§ 01|intro|Introduction|Intro",
      "--title", "Hello",
    ]);
    assertEquals(code, 0);
    assert(await exists(join(home, "_migrated", "hello.html")));
    const registry = await Deno.readTextFile(join(home, "registry.jsonc"));
    assertStringIncludes(registry, '"slug": "hello"');
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(srcDir, { recursive: true });
  }
});
```

Ensure `add-doc_test.ts` imports `assert`, `assertEquals`, `assertStringIncludes` (merge with existing imports).

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env add-doc_test.ts`
Expected: FAIL — `addDocMain` not exported.

- [ ] **Step 3: Implement `addDocMain`** — in `src/add-doc.ts`, update imports:

```ts
import { resolveHome } from "./config.ts";
import { ensureHome } from "./init.ts";
```

(Add these alongside the existing imports.)

Replace the `import.meta.main` block (lines 27-82) with `addDocMain` + a guard. The body is the existing logic, with three changes: (a) `ROOT = resolveHome(a.root)`, (b) `await ensureHome(ROOT)` before reading the registry, (c) add `"root"` to the `string` flag list, (d) `return 0` at the end and `throw` on errors (already the case):

```ts
export async function addDocMain(args: string[]): Promise<number> {
  const a = parseArgs(args, {
    string: [
      "root",
      "src",
      "topic",
      "slug",
      "title",
      "kind",
      "desc",
      "foot-left",
      "foot-right",
      "visibility",
      "new-topic",
    ],
    boolean: ["review"],
    default: { visibility: "private" },
  });

  const ROOT = resolveHome(a.root); // the content home this doc is being filed into
  await ensureHome(ROOT);
  const REGISTRY_PATH = join(ROOT, "registry.jsonc");
  const MIGRATED = join(ROOT, "_migrated");

  if (!a.src) throw new Error("--src <file.html> is required");
  if (!(await exists(a.src))) throw new Error(`source not found: ${a.src}`);
  const html = await Deno.readTextFile(a.src);
  if (!/<body[^>]*>/i.test(html)) throw new Error(`source has no <body>: ${a.src}`);

  const slug = a.slug ?? basename(a.src).replace(/\.html?$/i, "");
  const visibility = a.visibility === "shared" ? "shared" : "private";
  const entry: DocEntry = {
    slug,
    title: a.title ?? slug,
    kind: a.kind ?? "Reference",
    desc: a.desc ?? "",
    footLeft: a["foot-left"] ?? "Reference",
    footRight: a["foot-right"] ?? "Reading Room",
    src: `${basename(ROOT)}/_migrated/${slug}.html`,
    visibility,
    ...(a.review ? { review: true } : {}),
  };

  // Place the authored file as the editorial override transformDoc checks first.
  await copy(a.src, join(MIGRATED, `${slug}.html`), { overwrite: true });

  let registry = await Deno.readTextFile(REGISTRY_PATH);
  if (a["new-topic"]) {
    const [num, id, name, short] = a["new-topic"].split("|");
    registry = insertTopic(registry, { num, id, name, short, docs: [entry] });
  } else {
    if (!a.topic) throw new Error("--topic <id> is required (or use --new-topic)");
    registry = insertDoc(registry, a.topic, entry);
  }
  await Deno.writeTextFile(REGISTRY_PATH, registry);
  console.log(`Added "${entry.title}" -> http://127.0.0.1:8413/docs/${slug}`);
  console.log(`Placed _migrated/${slug}.html ; run \`reading-room serve\` to view.`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await addDocMain(Deno.args));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env add-doc_test.ts`
Expected: PASS — new end-to-end test + existing re-export tests.

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/add-doc.ts add-doc_test.ts && deno lint src/add-doc.ts add-doc_test.ts
git add src/add-doc.ts add-doc_test.ts
git commit -m "refactor(add-doc): lift into addDocMain(args) with home resolution + ensureHome"
```

---

## Task 8: lift `publishMain` in publish.ts

**Files:**
- Modify: `src/publish.ts:42-92` (the `import.meta.main` block) + imports
- Test: `publish_test.ts` (append a `--dry-run` smoke test)
- Depends on: Task 1

The lift converts the script's `Deno.exit(n)` calls into `return n` so `publishMain` yields an exit code; the guard does `Deno.exit(await publishMain(Deno.args))`.

- [ ] **Step 1: Write the failing test** — append to `publish_test.ts`:

```ts
import { publishMain } from "./src/publish.ts";
import { join } from "jsr:@std/path@1";

Deno.test("publishMain --dry-run returns 0 and builds nothing destructive", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(home, "registry.jsonc"),
      '[\n  { "num": "§ 01", "id": "t", "name": "T", "short": "T", "docs": [] }\n]\n',
    );
    await Deno.writeTextFile(
      join(home, "publish.jsonc"),
      '{ "cmd": ["echo", "{out}"] }\n',
    );
    const code = await publishMain(["--root", home, "--dry-run"]);
    assertEquals(code, 0);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
```

Ensure `publish_test.ts` imports `assertEquals` (merge with existing).

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env --allow-run publish_test.ts`
Expected: FAIL — `publishMain` not exported.

- [ ] **Step 3: Implement `publishMain`** — in `src/publish.ts`, update imports:

```ts
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { makeContext, resolveHome } from "./config.ts";
```

(Replace the existing `import { makeContext } from "./config.ts";` line.)

Replace the `import.meta.main` block (lines 42-92) with `publishMain` (each former `Deno.exit(n)` becomes `return n`) + a guard:

```ts
export async function publishMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["root"], boolean: ["dry-run"] });
  const dryRun = a["dry-run"];
  const ctx = await makeContext(resolveHome(a.root));
  const out = join(ctx.root, ".publish");
  const { docs } = await build(ctx, { outDir: out, sharedOnly: true });
  if (docs === 0) {
    console.log("\n  Note: no docs are visibility:shared — the published site would be empty.");
  }
  const cfgPath = join(ctx.root, "publish.jsonc");
  if (!(await exists(cfgPath))) {
    console.log(`\n  Built shared subset -> ${out}`);
    console.log(`  No publish.jsonc — create one to push, e.g.:`);
    console.log(`    { "cmd": ["aws", "s3", "sync", "{out}", "s3://my-bucket", "--delete"] }`);
    return 0;
  }
  let rawCfg: unknown;
  try {
    rawCfg = parseJsonc(await Deno.readTextFile(cfgPath));
  } catch (err) {
    console.error(`  publish.jsonc is not valid JSONC: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  const cfg = parsePublishConfig(rawCfg);
  if (typeof cfg === "string") {
    console.error(`  publish.jsonc invalid: ${cfg}`);
    return 1;
  }
  const argv = resolveCmd(cfg.cmd, out);
  if (dryRun) {
    console.log(`\n  dry-run — would run:\n    ${argv.join(" ")}`);
    return 0;
  }
  console.log(`\n  Running: ${argv.join(" ")}\n`);
  let status;
  try {
    status = await new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(`  command not found: ${argv[0]}`);
      return 1;
    }
    throw err;
  }
  return status.code;
}

if (import.meta.main) {
  Deno.exit(await publishMain(Deno.args));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env --allow-run publish_test.ts`
Expected: PASS — new dry-run test + existing config tests.

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/publish.ts publish_test.ts && deno lint src/publish.ts publish_test.ts
git add src/publish.ts publish_test.ts
git commit -m "refactor(publish): lift into publishMain(args) returning an exit code"
```

---

## Task 9: `src/cli.ts` dispatcher + `cli_test.ts`

**Files:**
- Create: `src/cli.ts`
- Test: `cli_test.ts`
- Depends on: Tasks 2, 4, 5, 6, 7, 8

- [ ] **Step 1: Write failing tests** — create `cli_test.ts`:

```ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";
import { cli } from "./src/cli.ts";
import { VERSION } from "./src/version.ts";

Deno.test("cli build --root builds into the home", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(home, "registry.jsonc"),
      '[\n  { "num": "§ 01", "id": "t", "name": "T", "short": "T", "docs": [] }\n]\n',
    );
    const code = await cli(["build", "--root", home]);
    assertEquals(code, 0);
    assertEquals(await exists(join(home, "index.html")), true);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("cli init --root scaffolds a home", async () => {
  const home = await Deno.makeTempDir();
  try {
    const code = await cli(["init", "--root", home]);
    assertEquals(code, 0);
    assertEquals(await exists(join(home, "site.jsonc")), true);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("cli --version prints VERSION and exits 0", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assertEquals(await cli(["--version"]), 0);
  } finally {
    console.log = orig;
  }
  assertEquals(lines.join("\n").trim(), VERSION);
});

Deno.test("cli --help prints usage to stdout and exits 0", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assertEquals(await cli(["--help"]), 0);
  } finally {
    console.log = orig;
  }
  assertStringIncludes(lines.join("\n"), "reading-room");
});

Deno.test("cli with unknown subcommand exits 1 with usage on stderr", async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m?: unknown) => void errs.push(String(m));
  try {
    assertEquals(await cli(["bogus"]), 1);
  } finally {
    console.error = orig;
  }
  assertStringIncludes(errs.join("\n"), "reading-room");
});

Deno.test("cli with no subcommand exits 1", async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    assertEquals(await cli([]), 1);
  } finally {
    console.error = orig;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env --allow-run cli_test.ts`
Expected: FAIL — `./src/cli.ts` does not exist.

- [ ] **Step 3: Implement `src/cli.ts`:**

```ts
/**
 * Reading Room CLI dispatcher. One installable command that routes to the
 * engine entry points (serve | build | add-doc | publish | init) plus
 * --help/--version. Each subcommand keeps parsing its own remaining args; this
 * module only routes. Distributed via `deno install -g jsr:.../cli` (see
 * _specs/2026-06-13-cli-distribution-design.md). Library callers use ./mod.ts.
 */
import { serveMain } from "./serve.ts";
import { buildMain } from "./build.ts";
import { addDocMain } from "./add-doc.ts";
import { publishMain } from "./publish.ts";
import { initMain } from "./init.ts";
import { VERSION } from "./version.ts";

const USAGE = `reading-room — editorial document library engine (v${VERSION})

Usage: reading-room <command> [options]

Commands:
  serve     [--root <dir>] [--port <n>]   Live server (127.0.0.1) + management/annotations
  build     [--root <dir>]                Static build of the full corpus
  publish   [--root <dir>] [--dry-run]    Build the shared subset and run publish.jsonc
  add-doc   [--root <dir>] --src <f> ...  Register a standalone editorial doc
  init      [--root <dir>]                Scaffold a content home

The content home is --root, else $READING_ROOM_HOME, else
\${XDG_DATA_HOME:-~/.local/share}/reading-room.

  -h, --help      Show this help
  -V, --version   Print the version`;

/** Route argv to a subcommand; returns the process exit code. */
export async function cli(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "serve":
        return await serveMain(rest);
      case "build":
        return await buildMain(rest);
      case "add-doc":
        return await addDocMain(rest);
      case "publish":
        return await publishMain(rest);
      case "init":
        return await initMain(rest);
      case "--version":
      case "-V":
        console.log(VERSION);
        return 0;
      case "--help":
      case "-h":
        console.log(USAGE);
        return 0;
      default:
        console.error(USAGE);
        return 1;
    }
  } catch (err) {
    console.error(`reading-room: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await cli(Deno.args));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env --allow-run cli_test.ts`
Expected: PASS (all six).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt src/cli.ts cli_test.ts && deno lint src/cli.ts cli_test.ts
git add src/cli.ts cli_test.ts
git commit -m "feat(cli): src/cli.ts dispatcher for serve|build|add-doc|publish|init"
```

---

## Task 10: deno.jsonc — version 0.2.0, ./cli export, dev tasks, mod.ts surface

**Files:**
- Modify: `deno.jsonc` (version, exports, tasks)
- Modify: `src/mod.ts` (export `resolveHome`, `ensureHome`, `initMain`)
- Modify: `src/version.ts` (regenerated to 0.2.0)
- Depends on: Task 9

- [ ] **Step 1: Bump version + add ./cli export + widen env + add --root to dev tasks** — in `deno.jsonc`:

Set `"version": "0.2.0"`.

Add to `exports` (after `./add-doc`):

```jsonc
    "./add-doc": "./src/add-doc.ts",
    "./cli": "./src/cli.ts"
```

Replace the four content-facing task lines so dev serves THIS repo (`--root .`) and the env union matches the installed CLI (`resolveHome` may read these):

```jsonc
    "build": "deno run --allow-read --allow-write --allow-env=READING_ROOM_HOME,XDG_DATA_HOME,HOME src/build.ts --root .",
    "serve": "deno run --allow-read --allow-write --allow-net --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME src/serve.ts --root .",
    "add-doc": "deno run --allow-read --allow-write --allow-env=READING_ROOM_HOME,XDG_DATA_HOME,HOME src/add-doc.ts --root .",
    "publish": "deno run --allow-read --allow-write --allow-run --allow-env=READING_ROOM_HOME,XDG_DATA_HOME,HOME src/publish.ts --root .",
    "cli": "deno run --allow-read --allow-write --allow-net --allow-run --allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME src/cli.ts",
```

Leave `gen` and `test` as they are (the `gen` task now also emits `src/version.ts` via Task 2's change to `gen-assets.ts`).

- [ ] **Step 2: Regenerate version.ts at the new version**

Run: `deno task gen`
Expected: `src/version.ts` now reads `export const VERSION: string = "0.2.0";`.

- [ ] **Step 3: Export the new library surface** — in `src/mod.ts`, extend the config re-export line and add init:

```ts
export { DEFAULT_SITE, loadSite, makeContext, parseSite, resolveHome } from "./config.ts";
```

Add near the other re-exports:

```ts
export { ensureHome, initMain } from "./init.ts";
```

- [ ] **Step 4: Verify the whole suite + version pin + a live CLI invocation**

Run: `deno test --allow-read --allow-write --allow-env --allow-run`
Expected: PASS, including `version_test.ts` now pinning `0.2.0`.

Run: `deno task cli --version`
Expected: prints `0.2.0`.

Run: `deno task cli build --root .` then confirm it builds (it writes `index.html`/`docs/` into the repo root — these are gitignored build artifacts).

- [ ] **Step 5: fmt + lint + commit**

```bash
deno fmt deno.jsonc src/mod.ts src/version.ts
deno lint src/mod.ts
git add deno.jsonc src/mod.ts src/version.ts
git commit -m "feat(cli): ship ./cli export, bump to 0.2.0, point dev tasks at --root ."
```

---

## Task 11: docs + conversion tooling

**Files:**
- Modify: `CLAUDE.md` (root-resolution contract; remove worktree-as-sibling gotcha; content-repo → content-home; replace the "known limitation" section)
- Modify: `README.md` (install → init → home + env override; no-install fallback)
- Modify: `convert-to-engine.sh` (thin wrapper around `reading-room init` + content move + install hint)
- Depends on: Tasks 9, 10

This task changes prose/scripts only — no new tests. Verify with `deno fmt --check` (Markdown is formatted) and by reading the diff.

- [ ] **Step 1: Update `CLAUDE.md`.** Make these specific edits (smallest reasonable changes — do not rewrite whole sections):
  - In "How the engine resolves an environment": change the contract from "Every entry point treats `Deno.cwd()` as the content root" to: the **library** still builds a `RoomContext` from an explicit root (default `Deno.cwd()`), but the **CLI** resolves the content home via `resolveHome` — `--root` → `$READING_ROOM_HOME` → `${XDG_DATA_HOME:-~/.local/share}/reading-room`. Note the entry points are now the `reading-room <subcommand>` CLI (with `deno run jsr:.../cli <sub>` as the no-install fallback), plus the back-compatible `./serve`-style exports.
  - In "The two-repo model": reframe "Content repo (per environment, private git repo)" as "Content home (per machine, a plain local directory at the resolved home path)". State plainly: no git, no sync (a later, separate concern); one library per machine.
  - In "Land mines": **remove** the worktree-as-sibling note from "Working conventions" (content is self-contained under the home; `_migrated/<slug>.html` overrides win over the vestigial scattered `src`). Keep the `deno fmt`/JSR-asset/admin-purity land mines.
  - Replace the "Known limitation / planned work" (version duplication) section with a short "Installed CLI" section: install once per machine via `deno install -g`, version is per-machine ambient state, `init` bootstraps the home; point at both specs.
  - Update "Releasing" step 4 (consumers upgrade) to: re-run `deno install -g -f` at the new version (per machine), not per-repo task edits.

- [ ] **Step 2: Update `README.md`.** Add an "Install" section:

````markdown
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
````

(Adjust surrounding prose minimally to fit; keep the existing README voice.)

- [ ] **Step 3: Rewrite `convert-to-engine.sh` as a thin wrapper.** It should: (a) run `reading-room init` (or print the `deno run jsr:.../cli init` fallback if the binary is absent), (b) move an existing content repo's `registry.jsonc`, `site.jsonc`, `_migrated/`, `comments/`, `assets/`, `publish.jsonc` into the resolved home (skip what's absent; never overwrite), (c) print the one-time `deno install -g` command and the launchd-agent note (agent runs `reading-room serve`, no `WorkingDirectory` needed). Keep it POSIX `sh`, `set -eu`, and echo each action. Do not delete the file.

- [ ] **Step 4: Verify formatting**

Run: `deno fmt --check CLAUDE.md README.md`
Expected: PASS (no diff). If it reports changes, run `deno fmt CLAUDE.md README.md` and re-check.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md convert-to-engine.sh
git commit -m "docs: document the installed CLI + content home; convert-to-engine wraps init"
```

---

## Task 12: full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate exactly as CI does**

```bash
deno fmt --check
deno lint
deno test --allow-read --allow-write --allow-env --allow-run
deno publish --dry-run
```

Expected: all four succeed. `deno publish --dry-run` must include `src/cli.ts`, `src/version.ts`, `src/init.ts` (they live under `src/`, which is in `publish.include`).

- [ ] **Step 2: Smoke-test the CLI end to end against a throwaway home**

```bash
TMP=$(mktemp -d)
deno run -A src/cli.ts init --root "$TMP"
printf '<html><body><h1>Hi</h1></body></html>' > "$TMP/hi.html"
deno run -A src/cli.ts add-doc --root "$TMP" --src "$TMP/hi.html" \
  --new-topic '§ 01|intro|Introduction|Intro' --title 'Hi'
deno run -A src/cli.ts build --root "$TMP"
test -f "$TMP/index.html" && test -f "$TMP/docs/hi/index.html" && echo OK
rm -rf "$TMP"
```

Expected: prints `OK` — init → add-doc → build round-trips on a fresh home.

- [ ] **Step 3: Report results** — summarize pass/fail of each gate command; if all green, the branch is ready for a PR.

---

## Self-review notes (author)

- **Spec coverage:** resolveHome (T1), version.ts (T2), empty-registry insertTopic (T3, surfaced during planning), init+ensureHome (T4), the four `*Main` lifts (T5-T8), cli dispatcher (T9), deno.jsonc/exports/version bump/dev `--root .` (T10), CLAUDE.md/README/convert-to-engine (T11), full gate (T12). Permission union documented in README (T11 Step 2). Per-machine migration + launchd note documented in CLAUDE.md/convert-to-engine (T11).
- **Out of scope (per spec):** Option B `deno compile`, moving dev content to `example/`, removing the `workspace`/scattered-`src` code, any sync mechanism.
- **Type consistency:** `*Main(args: string[]): Promise<number>` across all five; `resolveHome(flagRoot?: string)`, `ensureHome(home)`, `initMain(args)`, `cli(args)` — names match across tasks and the cli imports.
