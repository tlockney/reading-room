import { assertEquals } from "jsr:@std/assert@1";
import { logPaths, plistPath, resolveDenoPath, resolveStateDir, type RunFn } from "./agent.ts";

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
