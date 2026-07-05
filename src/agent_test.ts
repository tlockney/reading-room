import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
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
  assertEquals(xml.includes("READONLY"), false);
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
