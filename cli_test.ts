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
