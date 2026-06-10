import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { type DocEntry, insertDoc, insertTopic, slugExists } from "./add-doc.ts";

const REGISTRY = `// header comment — must survive
[
  {
    "num": "§ 01", "id": "data-platform",
    "name": "Data Platform", "short": "Data Platform",
    "docs": [
      { "slug": "alpha", "title": "Alpha", "kind": "Guide", "desc": "d",
        "footLeft": "L", "footRight": "R", "src": "a.html", "visibility": "private" }
    ]
  }
]
`;

const ENTRY: DocEntry = {
  slug: "beta",
  title: "Beta",
  kind: "Plan",
  desc: "second",
  footLeft: "2026·06·07",
  footRight: "Repo",
  src: "reading-room/_migrated/beta.html",
  visibility: "private",
};

Deno.test("insertDoc adds the entry to the named topic", () => {
  const out = insertDoc(REGISTRY, "data-platform", ENTRY);
  const corpus = parseJsonc(out) as Array<{ id: string; docs: Array<{ slug: string }> }>;
  const topic = corpus.find((t) => t.id === "data-platform")!;
  assertEquals(topic.docs.map((d) => d.slug), ["alpha", "beta"]);
});

Deno.test("insertDoc preserves the header comment", () => {
  const out = insertDoc(REGISTRY, "data-platform", ENTRY);
  assert(out.startsWith("// header comment — must survive"));
});

Deno.test("insertDoc rejects an unknown topic", () => {
  assertThrows(() => insertDoc(REGISTRY, "nope", ENTRY), Error, "topic");
});

Deno.test("insertDoc rejects a duplicate slug", () => {
  assertThrows(
    () => insertDoc(REGISTRY, "data-platform", { ...ENTRY, slug: "alpha" }),
    Error,
    "slug",
  );
});

Deno.test("slugExists scans all topics", () => {
  assert(slugExists(REGISTRY, "alpha"));
  assertEquals(slugExists(REGISTRY, "beta"), false);
});

Deno.test("insertTopic appends a new topic before the closing bracket", () => {
  const out = insertTopic(REGISTRY, {
    num: "§ 02",
    id: "ops",
    name: "Operations",
    short: "Ops",
    docs: [ENTRY],
  });
  const corpus = parseJsonc(out) as Array<{ id: string }>;
  assertEquals(corpus.map((t) => t.id), ["data-platform", "ops"]);
});
