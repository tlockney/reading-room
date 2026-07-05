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
import { artifactMain } from "./artifact-cli.ts";
import { VERSION } from "./version.ts";

const USAGE = `reading-room — editorial document library engine (v${VERSION})

Usage: reading-room <command> [options]

Commands:
  serve     [--root <dir>] [--port <n>]   Live server (127.0.0.1) + management/annotations
  build     [--root <dir>]                Static build of the full corpus
  publish   [--root <dir>] [--dry-run]    Build the shared subset and run publish.jsonc
  add-doc   [--root <dir>] --src <f> ...  Register a standalone editorial doc
  artifact  <path> | list | update <slug> <p> | rm <slug>   Manage raw-served artifacts
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
      case "artifact":
        return await artifactMain(rest);
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
