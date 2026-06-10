#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * Publish the Reading Room — build the visibility:shared subset into
 * .publish/ (gitignored; the local full build in docs/ is untouched), then
 * hand the directory to the command configured in publish.jsonc:
 *
 *   { "cmd": ["aws", "s3", "sync", "{out}", "s3://my-bucket", "--delete"] }
 *
 * `{out}` is replaced with the absolute output directory. No publish.jsonc →
 * build only, print the directory and a hint. --dry-run → build, print the
 * resolved command, run nothing.
 *
 * Note: links from shared docs to private docs are not rewritten and will be dead in the published output.
 *
 *   deno task publish [--dry-run]
 */
import { join } from "jsr:@std/path@1";
import { exists } from "jsr:@std/fs@1";
import { parse as parseJsonc } from "jsr:@std/jsonc@1";
import { build } from "./build.ts";
import { ROOT } from "./render.ts";

export interface PublishConfig {
  cmd: string[];
}

/** Validate the parsed publish.jsonc shape, or explain why not. */
export function parsePublishConfig(raw: unknown): PublishConfig | string {
  if (typeof raw !== "object" || raw === null) return "publish.jsonc must be a JSON object";
  const cmd = (raw as Record<string, unknown>).cmd;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === "string")) {
    return 'publish.jsonc needs "cmd": a non-empty array of strings';
  }
  return { cmd: cmd as string[] };
}

/** Substitute {out} into the configured argv. */
export function resolveCmd(cmd: string[], out: string): string[] {
  return cmd.map((a) => a.replaceAll("{out}", out));
}

if (import.meta.main) {
  const dryRun = Deno.args.includes("--dry-run");
  const out = join(ROOT, ".publish");
  const { docs } = await build({ outDir: out, sharedOnly: true });
  if (docs === 0) {
    console.log("\n  Note: no docs are visibility:shared — the published site would be empty.");
  }
  const cfgPath = join(ROOT, "publish.jsonc");
  if (!(await exists(cfgPath))) {
    console.log(`\n  Built shared subset -> ${out}`);
    console.log(`  No publish.jsonc — create one to push, e.g.:`);
    console.log(`    { "cmd": ["aws", "s3", "sync", "{out}", "s3://my-bucket", "--delete"] }`);
    Deno.exit(0);
  }
  let rawCfg: unknown;
  try {
    rawCfg = parseJsonc(await Deno.readTextFile(cfgPath));
  } catch (err) {
    console.error(
      `  publish.jsonc is not valid JSONC: ${err instanceof Error ? err.message : err}`,
    );
    Deno.exit(1);
  }
  const cfg = parsePublishConfig(rawCfg);
  if (typeof cfg === "string") {
    console.error(`  publish.jsonc invalid: ${cfg}`);
    Deno.exit(1);
  }
  const argv = resolveCmd(cfg.cmd, out);
  if (dryRun) {
    console.log(`\n  dry-run — would run:\n    ${argv.join(" ")}`);
    Deno.exit(0);
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
      Deno.exit(1);
    }
    throw err;
  }
  Deno.exit(status.code);
}
