import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { removeDoc, setDocField, UnknownSlugError } from "./src/registry-edit.ts";

// Three docs across two topics; header comment and hand-formatting must survive.
const REGISTRY = `// header comment — must survive
[
  {
    "num": "§ 01", "id": "tooling",
    "name": "Tooling", "short": "Tooling",
    "docs": [
      { "slug": "alpha", "title": "Alpha", "kind": "Guide", "desc": "first [tricky] {chars}",
        "footLeft": "L", "footRight": "R", "src": "a.html", "visibility": "private" },
      { "slug": "beta", "title": "Beta", "kind": "Guide", "desc": "second",
        "footLeft": "L", "footRight": "R", "src": "b.html", "visibility": "shared", "review": true }
    ]
  },
  {
    "num": "§ 02", "id": "loops",
    "name": "Loops", "short": "Loops",
    "docs": [
      { "slug": "gamma", "title": "Gamma", "kind": "Essay", "desc": "third",
        "footLeft": "L", "footRight": "R", "src": "g.html", "visibility": "private" }
    ]
  }
]
`;

interface ParsedTopic {
  id: string;
  docs: Array<{ slug: string; visibility?: string; review?: boolean }>;
}
const parsed = (s: string): ParsedTopic[] => parseJsonc(s) as unknown as ParsedTopic[];
const docOf = (s: string, slug: string) => {
  for (const t of parsed(s)) for (const d of t.docs) if (d.slug === slug) return d;
  throw new Error(`no ${slug}`);
};

Deno.test("setDocField turns review on", () => {
  const out = setDocField(REGISTRY, "alpha", { review: true });
  assertEquals(docOf(out, "alpha").review, true);
  assert(out.startsWith("// header comment — must survive"));
});

Deno.test("setDocField review:false removes the key entirely", () => {
  const out = setDocField(REGISTRY, "beta", { review: false });
  assertEquals("review" in docOf(out, "beta"), false);
  assertEquals(out.includes('"slug": "beta"'), true);
});

Deno.test("setDocField review round-trip restores the original text", () => {
  const on = setDocField(REGISTRY, "alpha", { review: true });
  const off = setDocField(on, "alpha", { review: false });
  assertEquals(off, REGISTRY);
});

Deno.test("setDocField replaces an existing visibility value", () => {
  const out = setDocField(REGISTRY, "alpha", { visibility: "shared" });
  assertEquals(docOf(out, "alpha").visibility, "shared");
  // other docs untouched
  assertEquals(docOf(out, "beta").visibility, "shared");
  assertEquals(docOf(out, "gamma").visibility, "private");
});

Deno.test("setDocField inserts visibility when the key is absent", () => {
  const noVis = REGISTRY.replace(`"src": "g.html", "visibility": "private"`, `"src": "g.html"`);
  const out = setDocField(noVis, "gamma", { visibility: "shared" });
  assertEquals(docOf(out, "gamma").visibility, "shared");
});

Deno.test("setDocField applies review and visibility together", () => {
  const out = setDocField(REGISTRY, "gamma", { review: true, visibility: "shared" });
  const d = docOf(out, "gamma");
  assertEquals(d.review, true);
  assertEquals(d.visibility, "shared");
});

Deno.test("setDocField leaves every other entry byte-identical", () => {
  const out = setDocField(REGISTRY, "beta", { visibility: "private" });
  // the alpha and gamma lines are untouched text
  assert(
    out.includes(
      `"slug": "alpha", "title": "Alpha", "kind": "Guide", "desc": "first [tricky] {chars}"`,
    ),
  );
  assert(
    out.includes(`"slug": "gamma", "title": "Gamma", "kind": "Essay", "desc": "third"`),
  );
});

Deno.test("setDocField throws UnknownSlugError for a missing slug", () => {
  assertThrows(() => setDocField(REGISTRY, "nope", { review: true }), UnknownSlugError, "nope");
});

Deno.test("removeDoc removes a first (non-last) entry and stays valid jsonc", () => {
  const out = removeDoc(REGISTRY, "alpha");
  const t = parsed(out).find((x) => x.id === "tooling")!;
  assertEquals(t.docs.map((d) => d.slug), ["beta"]);
  assert(out.startsWith("// header comment — must survive"));
});

Deno.test("removeDoc removes a last entry (eats the preceding comma)", () => {
  const out = removeDoc(REGISTRY, "beta");
  const t = parsed(out).find((x) => x.id === "tooling")!;
  assertEquals(t.docs.map((d) => d.slug), ["alpha"]);
});

Deno.test("removeDoc removes the only doc, leaving an empty (valid) topic", () => {
  const out = removeDoc(REGISTRY, "gamma");
  const t = parsed(out).find((x) => x.id === "loops")!;
  assertEquals(t.docs, []);
});

Deno.test("removeDoc throws UnknownSlugError for a missing slug", () => {
  assertThrows(() => removeDoc(REGISTRY, "nope"), UnknownSlugError, "nope");
});

Deno.test("surgery tolerates brackets and braces inside string values", () => {
  // alpha's desc contains "[tricky] {chars}" — entry-range scanning must skip strings
  const out = removeDoc(REGISTRY, "alpha");
  assertEquals(parsed(out).find((x) => x.id === "tooling")!.docs.length, 1);
});
