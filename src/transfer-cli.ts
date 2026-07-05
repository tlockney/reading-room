/**
 * `reading-room send <slug> <peer>` — send a library doc to another Reading
 * Room instance by driving the local server's /api/docs/<slug>/send route over
 * 127.0.0.1 (the server, not this CLI, reaches the peer). The peer is resolved
 * from the local server's /api/peers (discovery) by name, or passed as a URL.
 */
import { parseArgs } from "jsr:@std/cli@1/parse-args";

interface PeerLike {
  url: string;
  name?: string;
  identity?: { name?: string };
}

export function resolvePort(flag: string | undefined, env: string | undefined): number {
  const raw = flag ?? env ?? "8413";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8413;
}

/** Target URL for the peer named `needle` (identity name, bare name, or an
 * exact url), or null when nothing matches. */
export function matchPeer(peers: PeerLike[], needle: string): string | null {
  if (/^https?:\/\//.test(needle)) return needle;
  for (const p of peers) {
    if (p.identity?.name === needle || p.name === needle || p.url === needle) return p.url;
  }
  return null;
}

export async function sendMain(args: string[]): Promise<number> {
  const a = parseArgs(args, { string: ["port"], boolean: ["with-comments"] });
  const [slug, peer] = a._.map(String);
  if (!slug || !peer) {
    console.error("usage: reading-room send <slug> <peer> [--with-comments] [--port N]");
    return 1;
  }
  const port = resolvePort(a.port, Deno.env.get("PORT"));
  const base = `http://127.0.0.1:${port}`;

  let peers: PeerLike[];
  try {
    const res = await fetch(`${base}/api/peers`);
    peers = ((await res.json()) as { peers?: PeerLike[] }).peers ?? [];
  } catch {
    console.error(`reading-room: no running Reading Room agent on :${port} — is it installed?`);
    return 1;
  }
  const target = matchPeer(peers, peer);
  if (!target) {
    console.error(`reading-room: no such peer "${peer}" (try: reading-room send ${slug} <url>)`);
    return 1;
  }

  const res = await fetch(`${base}/api/docs/${slug}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, withComments: a["with-comments"] === true }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`reading-room: ${res.status} ${text}`);
    return 1;
  }
  console.log(text);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await sendMain(Deno.args));
}
