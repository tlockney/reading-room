import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type AgentDeps,
  agentMain,
  buildServeArgs,
  logPaths,
  plistPath,
  renderPlist,
  resolveDenoPath,
  resolveStateDir,
  type RunFn,
} from "./agent.ts";

const noRun: RunFn = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });

Deno.test("resolveStateDir prefers XDG_STATE_HOME, else HOME/.local/state", () => {
  const withXdg = (k: string) =>
    ({ XDG_STATE_HOME: "/xdg/state", HOME: "/home/t" } as Record<string, string>)[k];
  assertEquals(resolveStateDir(withXdg), "/xdg/state/reading-room");
  const withHome = (k: string) => (k === "HOME" ? "/home/t" : undefined);
  assertEquals(resolveStateDir(withHome), "/home/t/.local/state/reading-room");
  // empty XDG_STATE_HOME falls through (|| not ??), never a cwd-relative path
  const emptyXdg = (k: string) =>
    ({ XDG_STATE_HOME: "", HOME: "/home/t" } as Record<string, string>)[k];
  assertEquals(resolveStateDir(emptyXdg), "/home/t/.local/state/reading-room");
});

Deno.test("logPaths derives out/err under the state dir", () => {
  assertEquals(logPaths("/s/reading-room"), {
    out: "/s/reading-room/agent.out.log",
    err: "/s/reading-room/agent.err.log",
  });
});

Deno.test("plistPath is under ~/Library/LaunchAgents with the fixed label", () => {
  assertEquals(
    plistPath("/Users/t"),
    "/Users/t/Library/LaunchAgents/local.reading-room.plist",
  );
});

Deno.test("resolveDenoPath precedence: flag > homebrew > mise > execPath", async () => {
  const noneExist = () => false;
  const homebrewExists = (p: string) => p === "/opt/homebrew/bin/deno";
  const miseRun: RunFn = (cmd, args) =>
    Promise.resolve(
      cmd === "mise" && args[0] === "which"
        ? { code: 0, stdout: "/mise/bin/deno\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
    );
  const execPath = () => "/exec/deno";

  assertEquals(
    await resolveDenoPath({ flag: "/flag/deno", exists: noneExist, run: miseRun, execPath }),
    "/flag/deno",
  );
  assertEquals(
    await resolveDenoPath({ exists: homebrewExists, run: miseRun, execPath }),
    "/opt/homebrew/bin/deno",
  );
  assertEquals(
    await resolveDenoPath({ exists: noneExist, run: miseRun, execPath }),
    "/mise/bin/deno",
  );
  assertEquals(
    await resolveDenoPath({ exists: noneExist, run: noRun, execPath }),
    "/exec/deno",
  );
});

Deno.test("buildServeArgs bakes the permission union, min-dep-age, pinned target, root, port", () => {
  assertEquals(
    buildServeArgs({ version: "9.9.9", home: "/home/t/.local/share/reading-room", port: 8413 }),
    [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-net",
      "--allow-run",
      "--allow-sys=hostname",
      "--allow-env=PORT,READONLY,READING_ROOM_HOME,XDG_DATA_HOME,HOME",
      "--minimum-dependency-age=0",
      "jsr:@tlockney/reading-room@9.9.9/serve",
      "--root",
      "/home/t/.local/share/reading-room",
      "--port",
      "8413",
    ],
  );
});

Deno.test("renderPlist emits a binary-direct plist with no WorkingDirectory", () => {
  const xml = renderPlist({
    denoPath: "/opt/homebrew/bin/deno",
    serveArgs: buildServeArgs({ version: "9.9.9", home: "/h/room", port: 8413 }),
    homeDir: "/Users/t",
    logOut: "/s/reading-room/agent.out.log",
    logErr: "/s/reading-room/agent.err.log",
    readonly: false,
  });
  assertStringIncludes(xml, "<key>Label</key><string>local.reading-room</string>");
  assertStringIncludes(xml, "<string>/opt/homebrew/bin/deno</string>");
  assertStringIncludes(xml, "<string>--minimum-dependency-age=0</string>");
  assertStringIncludes(xml, "<string>jsr:@tlockney/reading-room@9.9.9/serve</string>");
  assertStringIncludes(
    xml,
    "<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
  );
  assertStringIncludes(xml, "<key>HOME</key><string>/Users/t</string>");
  assertStringIncludes(
    xml,
    "<key>StandardOutPath</key><string>/s/reading-room/agent.out.log</string>",
  );
  assertStringIncludes(xml, "<key>RunAtLoad</key><true/>");
  assertStringIncludes(xml, "<key>KeepAlive</key><true/>");
  assertEquals(xml.includes("WorkingDirectory"), false);
  assertEquals(xml.includes("<key>READONLY</key>"), false);
});

Deno.test("renderPlist adds READONLY=1 to the env when readonly", () => {
  const xml = renderPlist({
    denoPath: "/opt/homebrew/bin/deno",
    serveArgs: ["run"],
    homeDir: "/Users/t",
    logOut: "/o",
    logErr: "/e",
    readonly: true,
  });
  assertStringIncludes(xml, "<key>READONLY</key><string>1</string>");
});

/** A recording AgentDeps: captures run() calls and written files, os=darwin. */
function fakeDeps(over: Partial<AgentDeps> = {}): {
  deps: AgentDeps;
  calls: { cmd: string; args: string[] }[];
  files: Map<string, string>;
  mkdirs: string[];
  removed: string[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  const files = new Map<string, string>();
  const mkdirs: string[] = [];
  const removed: string[] = [];
  const deps: AgentDeps = {
    run: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "id") return Promise.resolve({ code: 0, stdout: "501\n", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    writeTextFile: (p, d) => {
      files.set(p, d);
      return Promise.resolve();
    },
    mkdir: (p) => {
      mkdirs.push(p);
      return Promise.resolve();
    },
    remove: (p) => {
      removed.push(p);
      return Promise.resolve();
    },
    readTextFile: () => Promise.resolve(""),
    exists: (p) => p === "/opt/homebrew/bin/deno",
    execPath: () => "/exec/deno",
    env: (k) => ({ HOME: "/Users/t", READING_ROOM_HOME: "/room" } as Record<string, string>)[k],
    os: "darwin",
    ...over,
  };
  return { deps, calls, files, mkdirs, removed };
}

Deno.test("agent --help prints usage and exits 0 without touching deps", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assertEquals(await agentMain(["--help"], fakeDeps({ os: "linux" }).deps), 0);
  } finally {
    console.log = orig;
  }
  assertStringIncludes(lines.join("\n"), "reading-room agent");
});

Deno.test("agent install refuses on non-macOS", async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m?: unknown) => void errs.push(String(m));
  try {
    assertEquals(await agentMain(["install"], fakeDeps({ os: "linux" }).deps), 1);
  } finally {
    console.error = orig;
  }
  assertStringIncludes(errs.join("\n"), "macOS");
});

Deno.test("agent install writes the plist and boots it, bootout before bootstrap", async () => {
  const f = fakeDeps();
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["install"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  // plist written to ~/Library/LaunchAgents with the resolved home baked in
  const plist = f.files.get("/Users/t/Library/LaunchAgents/local.reading-room.plist");
  assertEquals(typeof plist, "string");
  assertStringIncludes(plist!, "<string>/opt/homebrew/bin/deno</string>");
  assertStringIncludes(plist!, "--root");
  assertStringIncludes(plist!, "<string>/room</string>"); // READING_ROOM_HOME resolved
  // launchctl bootout precedes bootstrap; tailscale serve --bg 8413 runs
  const seq = f.calls.filter((c) => c.cmd === "launchctl").map((c) => c.args[0]);
  assertEquals(seq, ["bootout", "bootstrap"]);
  const ts = f.calls.find((c) => c.cmd === "tailscale");
  assertEquals(ts?.args, ["serve", "--bg", "8413"]);
});

Deno.test("agent install honors --port and --root", async () => {
  const f = fakeDeps();
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["install", "--port", "9000", "--root", "/custom"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  const plist = f.files.get("/Users/t/Library/LaunchAgents/local.reading-room.plist")!;
  assertStringIncludes(plist, "<string>/custom</string>");
  assertStringIncludes(plist, "<string>9000</string>");
  const ts = f.calls.find((c) => c.cmd === "tailscale");
  assertEquals(ts?.args, ["serve", "--bg", "9000"]);
});

Deno.test("agent install exits 1 on an invalid --port instead of throwing", async () => {
  const f = fakeDeps();
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m?: unknown) => void errs.push(String(m));
  try {
    assertEquals(await agentMain(["install", "--port", "abc"], f.deps), 1);
  } finally {
    console.error = orig;
  }
  assertStringIncludes(errs.join("\n"), "invalid port");
});

Deno.test("agent uninstall boots out, resets tailscale, removes the plist", async () => {
  const f = fakeDeps();
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["uninstall"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  const lc = f.calls.find((c) => c.cmd === "launchctl");
  assertEquals(lc?.args, ["bootout", "gui/501/local.reading-room"]);
  const ts = f.calls.find((c) => c.cmd === "tailscale");
  assertEquals(ts?.args, ["serve", "reset"]);
  assertEquals(f.removed, ["/Users/t/Library/LaunchAgents/local.reading-room.plist"]);
});

Deno.test("agent status queries launchctl print and tailscale serve status", async () => {
  const f = fakeDeps();
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["status"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  const lc = f.calls.find((c) => c.cmd === "launchctl");
  assertEquals(lc?.args, ["print", "gui/501/local.reading-room"]);
  const ts = f.calls.find((c) => c.cmd === "tailscale");
  assertEquals(ts?.args, ["serve", "status"]);
});

Deno.test("agent logs tails the two log files under the state dir", async () => {
  const reads: string[] = [];
  const f = fakeDeps({
    env: (k) => (k === "XDG_STATE_HOME" ? "/s" : k === "HOME" ? "/Users/t" : undefined),
    readTextFile: (p) => {
      reads.push(p);
      return Promise.resolve("line1\nline2\n");
    },
  });
  const orig = console.log;
  console.log = () => {};
  try {
    assertEquals(await agentMain(["logs"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  assertEquals(reads, ["/s/reading-room/agent.out.log", "/s/reading-room/agent.err.log"]);
});

Deno.test("agent logs prints '(no log yet)' when a log file is unreadable", async () => {
  const f = fakeDeps({
    env: (k) => (k === "XDG_STATE_HOME" ? "/s" : k === "HOME" ? "/Users/t" : undefined),
    readTextFile: () => Promise.reject(new Error("ENOENT")),
  });
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => void lines.push(String(m));
  try {
    assertEquals(await agentMain(["logs"], f.deps), 0);
  } finally {
    console.log = orig;
  }
  assertStringIncludes(lines.join("\n"), "(no log yet)");
});
