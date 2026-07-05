/**
 * `reading-room artifact` — publish/list/update/remove artifacts by driving the
 * running server's /api/artifacts routes over 127.0.0.1. The server (not this
 * CLI) reaches the tailnet; the CLI only needs localhost. Port resolves
 * --port → $PORT → 8413 (the agent default).
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { resolve } from "jsr:@std/path@1";

export interface PlannedRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, string>;
}

export function resolvePort(flag: string | undefined, env: string | undefined): number {
  const raw = flag ?? env ?? "8413";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8413;
}

const USAGE = "usage: reading-room artifact <path> | list | update <slug> <path> | rm <slug>";

/** Map argv (sub + rest) and parsed flags to an HTTP request, or a usage string. */
export function planRequest(
  rest: string[],
  flags: { name?: string; title?: string },
): PlannedRequest | string {
  const [a, b, c] = rest;
  if (!a) return USAGE;
  if (a === "list") return { method: "GET", path: "/api/artifacts" };
  if (a === "rm") return b ? { method: "DELETE", path: `/api/artifacts/${b}` } : USAGE;
  if (a === "update") {
    return b && c
      ? { method: "PUT", path: `/api/artifacts/${b}`, body: { path: resolve(c) } }
      : USAGE;
  }
  // default: publish a path
  const body: Record<string, string> = { path: resolve(a) };
  if (flags.name) body.name = flags.name;
  if (flags.title) body.title = flags.title;
  return { method: "POST", path: "/api/artifacts", body };
}

export async function artifactMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["name", "title", "port"] });
  const plan = planRequest(a._.map(String), { name: a.name, title: a.title });
  if (typeof plan === "string") {
    console.error(plan);
    return 1;
  }
  const port = resolvePort(a.port, Deno.env.get("PORT"));
  const url = `http://127.0.0.1:${port}${plan.path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: plan.method,
      headers: plan.body ? { "content-type": "application/json" } : undefined,
      body: plan.body ? JSON.stringify(plan.body) : undefined,
    });
  } catch {
    console.error(
      `reading-room: no running Reading Room agent on :${port} — is it installed? (see agent.sh install)`,
    );
    return 1;
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`reading-room: ${res.status} ${text}`);
    return 1;
  }
  console.log(text);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await artifactMain(Deno.args));
}
