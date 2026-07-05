import { assertEquals } from "jsr:@std/assert@1";
import { planRequest, resolvePort } from "./artifact-cli.ts";

Deno.test("resolvePort: flag > $PORT > 8413", () => {
  assertEquals(resolvePort("9000", undefined), 9000);
  assertEquals(resolvePort(undefined, "7000"), 7000);
  assertEquals(resolvePort(undefined, undefined), 8413);
  assertEquals(resolvePort(undefined, "garbage"), 8413);
});

Deno.test("planRequest maps subcommands to method + path + body", () => {
  assertEquals(planRequest(["/abs/x.html"], {}), {
    method: "POST",
    path: "/api/artifacts",
    body: { path: "/abs/x.html" },
  });
  assertEquals(planRequest(["/abs/x.html"], { name: "Foo", title: "Bar" }), {
    method: "POST",
    path: "/api/artifacts",
    body: { path: "/abs/x.html", name: "Foo", title: "Bar" },
  });
  assertEquals(planRequest(["list"], {}), { method: "GET", path: "/api/artifacts" });
  assertEquals(planRequest(["update", "mock", "/abs/y.html"], {}), {
    method: "PUT",
    path: "/api/artifacts/mock",
    body: { path: "/abs/y.html" },
  });
  assertEquals(planRequest(["rm", "mock"], {}), { method: "DELETE", path: "/api/artifacts/mock" });
});

Deno.test("planRequest rejects malformed invocations", () => {
  assertEquals(
    planRequest([], {}),
    "usage: reading-room artifact <path> | list | update <slug> <path> | rm <slug>",
  );
  assertEquals(typeof planRequest(["rm"], {}), "string");
  assertEquals(typeof planRequest(["update", "mock"], {}), "string");
});
