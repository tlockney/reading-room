import { assertEquals } from "jsr:@std/assert@1";
import {
  buildIdentity,
  discoverPeers,
  makeCachedDiscover,
  parseSelfDnsName,
  parseTailscalePeers,
  type PeerIdentity,
  probePeer,
  selfDnsName,
  type TailscalePeer,
} from "./discovery.ts";
import type { Topic } from "./render.ts";

const STATUS = {
  Self: { HostName: "laptop", DNSName: "laptop.tail-scale.ts.net.", Online: true },
  Peer: {
    "key1": { HostName: "studio", DNSName: "studio.tail-scale.ts.net.", Online: true },
    "key2": { HostName: "nas", DNSName: "nas.tail-scale.ts.net.", Online: false },
    "key3": { HostName: "noDns" },
  },
};

Deno.test("parseTailscalePeers maps Peer entries, strips trailing dot, excludes self", () => {
  const peers = parseTailscalePeers(STATUS);
  assertEquals(peers.length, 2);
  assertEquals(peers[0], { name: "studio", dnsName: "studio.tail-scale.ts.net", online: true });
  assertEquals(peers[1].online, false);
});

Deno.test("parseTailscalePeers tolerates junk", () => {
  assertEquals(parseTailscalePeers({}), []);
  assertEquals(parseTailscalePeers(null), []);
  assertEquals(parseTailscalePeers({ Peer: 5 }), []);
});

Deno.test("buildIdentity counts topics and docs", () => {
  const corpus: Topic[] = [
    { num: "1", id: "a", name: "A", short: "A", docs: [{ slug: "x" } as Topic["docs"][number]] },
    {
      num: "2",
      id: "b",
      name: "B",
      short: "B",
      docs: [{ slug: "y" }, { slug: "z" }] as Topic["docs"],
    },
  ];
  assertEquals(buildIdentity("Studio", corpus, "9.9.9"), {
    name: "Studio",
    version: "9.9.9",
    topics: 2,
    docs: 3,
  });
});

Deno.test("probePeer returns identity on a valid response, null otherwise", async () => {
  const good: PeerIdentity = { name: "Studio", version: "0.2.0", topics: 2, docs: 5 };
  const okFetch =
    ((_u: string | URL | Request) =>
      Promise.resolve(new Response(JSON.stringify(good)))) as typeof fetch;
  assertEquals(await probePeer("https://studio.ts.net/", okFetch), good);

  const notFound = (() => Promise.resolve(new Response("no", { status: 404 }))) as typeof fetch;
  assertEquals(await probePeer("https://studio.ts.net/", notFound), null);

  const garbage = (() => Promise.resolve(new Response("not json"))) as typeof fetch;
  assertEquals(await probePeer("https://studio.ts.net/", garbage), null);

  const boom = (() => Promise.reject(new Error("refused"))) as typeof fetch;
  assertEquals(await probePeer("https://studio.ts.net/", boom), null);
});

Deno.test("discoverPeers unions tailnet+seeds, dedupes, drops non-answering", async () => {
  const listPeers = (): Promise<TailscalePeer[]> =>
    Promise.resolve([
      { name: "studio", dnsName: "studio.ts.net", online: true },
      { name: "nas", dnsName: "nas.ts.net", online: false },
    ]);
  const idents: Record<string, PeerIdentity> = {
    "https://studio.ts.net/": { name: "Studio", version: "0.2.0", topics: 1, docs: 1 },
    "https://seed.ts.net/": { name: "Seed", version: "0.2.0", topics: 0, docs: 0 },
  };
  const probe = (url: string): Promise<PeerIdentity | null> => Promise.resolve(idents[url] ?? null);

  const peers = await discoverPeers({
    listPeers,
    probe,
    seeds: ["https://seed.ts.net/", "https://studio.ts.net/"],
  });
  const urls = peers.map((p) => p.url).sort();
  assertEquals(urls, ["https://seed.ts.net/", "https://studio.ts.net/"]);
});

Deno.test("makeCachedDiscover serves from cache within TTL", async () => {
  let calls = 0;
  const listPeers = (): Promise<TailscalePeer[]> => {
    calls++;
    return Promise.resolve([{ name: "s", dnsName: "s.ts.net", online: true }]);
  };
  const probe = (): Promise<PeerIdentity | null> =>
    Promise.resolve({ name: "S", version: "0.2.0", topics: 0, docs: 0 });
  const discover = makeCachedDiscover({ listPeers, probe }, 30_000);
  await discover();
  await discover();
  assertEquals(calls, 1);
});

Deno.test("discoverPeers dedupes a no-slash seed against the canonical tailnet url", async () => {
  const listPeers = (): Promise<TailscalePeer[]> =>
    Promise.resolve([{ name: "studio", dnsName: "studio.ts.net", online: true }]);
  const probe = (url: string): Promise<PeerIdentity | null> =>
    Promise.resolve(
      url === "https://studio.ts.net/"
        ? { name: "Studio", version: "0.2.0", topics: 1, docs: 1 }
        : null,
    );
  const peers = await discoverPeers({
    listPeers,
    probe,
    seeds: ["https://studio.ts.net"], // no trailing slash — same host as the tailnet peer
  });
  assertEquals(peers.length, 1);
  assertEquals(peers[0].url, "https://studio.ts.net/");
});

Deno.test("probePeer rejects a response missing name", async () => {
  const bad = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ version: "0.2.0", topics: 0, docs: 0 })),
    )) as typeof fetch;
  assertEquals(await probePeer("https://x.ts.net/", bad), null);
});

Deno.test("parseSelfDnsName reads Self.DNSName and strips the trailing dot", () => {
  assertEquals(
    parseSelfDnsName({ Self: { DNSName: "studio.tail1234.ts.net." } }),
    "studio.tail1234.ts.net",
  );
  assertEquals(parseSelfDnsName({ Self: {} }), null);
  assertEquals(parseSelfDnsName({}), null);
  assertEquals(parseSelfDnsName("nope"), null);
});

Deno.test("selfDnsName runs tailscale status and parses Self", async () => {
  const fakeRun = (_cmd: string, _args: string[]) =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ Self: { DNSName: "h.tail1.ts.net." } }),
    });
  assertEquals(await selfDnsName(fakeRun), "h.tail1.ts.net");
});

Deno.test("selfDnsName returns null when tailscale fails", async () => {
  const fail = (_c: string, _a: string[]) => Promise.resolve({ code: 1, stdout: "" });
  assertEquals(await selfDnsName(fail), null);
});
