/**
 * Reading Room — peer discovery (serve-only). The tailnet is the membership
 * source: enumerate `tailscale status --json`, probe each candidate's
 * /.well-known/reading-room.json to confirm it runs Reading Room, and return
 * the live peers for the masthead switcher. build.ts MUST NOT import this
 * module (serve-only, like admin.ts; build-purity is pinned in admin_test.ts).
 *
 * The tailscale call and the HTTP probe are injected so the suite runs without
 * a real tailnet or network.
 */
import type { Site } from "./config.ts";
import type { Topic } from "./render.ts";

export interface PeerIdentity {
  title: string;
  version: string;
  topics: number;
  docs: number;
}

/** A live peer: only instances that answered the identity probe are returned. */
export interface Peer {
  name: string;
  url: string;
  identity: PeerIdentity;
}

/** A discovery candidate from the tailnet, pre-probe. */
export interface TailscalePeer {
  name: string;
  dnsName: string;
  online: boolean;
}

export interface DiscoverOptions {
  listPeers: () => Promise<TailscalePeer[]>;
  probe: (url: string) => Promise<PeerIdentity | null>;
  seeds?: string[];
}

export type RunFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** The identity this instance advertises at /.well-known/reading-room.json. */
export function buildIdentity(site: Site, corpus: Topic[], version: string): PeerIdentity {
  return {
    title: site.title,
    version,
    topics: corpus.length,
    docs: corpus.reduce((n, t) => n + t.docs.length, 0),
  };
}

/** Narrow an unknown probe response to a PeerIdentity, or null. */
function asIdentity(raw: unknown): PeerIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.title !== "string" || typeof o.version !== "string" ||
    typeof o.topics !== "number" || typeof o.docs !== "number"
  ) return null;
  return { title: o.title, version: o.version, topics: o.topics, docs: o.docs };
}

/** Parse `tailscale status --json` into candidate hosts. Self is reported
 * separately from Peer, so it is naturally excluded. Tolerant of junk. */
export function parseTailscalePeers(raw: unknown): TailscalePeer[] {
  if (typeof raw !== "object" || raw === null) return [];
  const peerMap = (raw as Record<string, unknown>).Peer;
  if (typeof peerMap !== "object" || peerMap === null) return [];
  const out: TailscalePeer[] = [];
  for (const v of Object.values(peerMap as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const p = v as Record<string, unknown>;
    const dnsName = typeof p.DNSName === "string" ? p.DNSName.replace(/\.$/, "") : "";
    if (!dnsName) continue;
    out.push({
      name: typeof p.HostName === "string" ? p.HostName : dnsName,
      dnsName,
      online: p.Online === true,
    });
  }
  return out;
}

const TAILSCALE_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

const defaultRun: RunFn = async (cmd, args) => {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
};

/** Resolve + run `tailscale status --json` and parse it. [] on any failure. */
export async function listTailscalePeers(run: RunFn = defaultRun): Promise<TailscalePeer[]> {
  for (const bin of TAILSCALE_BINS) {
    try {
      const { code, stdout } = await run(bin, ["status", "--json"]);
      if (code !== 0) continue;
      return parseTailscalePeers(JSON.parse(stdout));
    } catch {
      // try the next candidate binary path
    }
  }
  return [];
}

/** Fetch <baseUrl>/.well-known/reading-room.json with a timeout; null on any
 * failure or invalid shape. */
export async function probePeer(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<PeerIdentity | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL(".well-known/reading-room.json", baseUrl).href;
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return asIdentity(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Union tailnet candidates (online only) with seeds, dedupe by URL, probe in
 * parallel, keep the ones that answer with a valid identity. */
export async function discoverPeers(opts: DiscoverOptions): Promise<Peer[]> {
  const candidates = new Map<string, string>(); // url -> name
  for (const c of await opts.listPeers()) {
    if (c.online) candidates.set(`https://${c.dnsName}/`, c.name);
  }
  for (const url of opts.seeds ?? []) {
    if (candidates.has(url)) continue;
    try {
      candidates.set(url, new URL(url).hostname);
    } catch {
      // skip a malformed seed
    }
  }
  const probed = await Promise.all(
    [...candidates].map(async ([url, name]): Promise<Peer | null> => {
      const identity = await opts.probe(url);
      return identity ? { name, url, identity } : null;
    }),
  );
  return probed.filter((p): p is Peer => p !== null);
}

/** Wrap discoverPeers with a TTL cache so /api/peers doesn't spawn tailscale
 * on every request; a single in-flight call is shared. */
export function makeCachedDiscover(
  opts: DiscoverOptions,
  ttlMs = 30_000,
): () => Promise<Peer[]> {
  let cache: { at: number; peers: Peer[] } | null = null;
  let inflight: Promise<Peer[]> | null = null;
  return () => {
    const now = Date.now();
    if (cache && now - cache.at < ttlMs) return Promise.resolve(cache.peers);
    if (inflight) return inflight;
    inflight = discoverPeers(opts)
      .then((peers) => {
        cache = { at: Date.now(), peers };
        inflight = null;
        return peers;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
    return inflight;
  };
}
