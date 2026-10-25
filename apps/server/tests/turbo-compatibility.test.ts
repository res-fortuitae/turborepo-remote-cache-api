import { expect, test } from "bun:test";
import { inProcessTarget, memoryBucket } from "./support/in-process.ts";
import { TURBO_COMPATIBILITY_DOCS } from "../src/turbo-compatibility.ts";
import { DashboardAssets } from "@repo/infra";

test("Turbo identity paths give actionable JSON even without credentials and bypass assets", async () => {
  const bucket = memoryBucket();
  bucket.failing = true;
  const target = inProcessTarget("secret", bucket);
  for (const path of [
    "/v2/user",
    "/v2/teams?limit=100",
    "/v2/teams/team_123",
    "/v0/spaces?limit=100",
    "/v5/user/tokens/current",
    "/v3/user/tokens/current",
    "/registration/verify?token=private",
    "/login/oauth/userinfo",
    "/login/oauth/device-authorization",
    "/.well-known/openid-configuration",
    "/login/oauth/token",
    "/login/oauth/token/introspect",
    "/login/oauth/token/revoke",
  ]) {
    const response = await target.fetch(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "unsupported_turbo_identity",
      message: `This cache uses tcache login / tcache link. See ${TURBO_COMPATIBILITY_DOCS}`,
      docs: TURBO_COMPATIBILITY_DOCS,
    });
    const pathname = new URL(path, "http://localhost").pathname;
    expect(
      DashboardAssets.runWorkerFirst.some((pattern) =>
        pattern.endsWith("/*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern,
      ),
    ).toBe(true);
  }
  expect((await target.fetch("/api/auth/token")).status).toBe(404);
});

test("Turbo preflight never redirects or touches storage and actual operations still authenticate", async () => {
  const bucket = memoryBucket();
  bucket.failing = true;
  const target = inProcessTarget("secret", bucket);
  for (const path of [
    "/v8/artifacts",
    "/v8/artifacts/abc?slug=org",
    "/v8/artifacts/status",
    "/v8/x/uploads",
  ]) {
    const response = await target.fetch(path, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "PUT",
        "access-control-request-headers": "Authorization, X-Artifact-Tag",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(await response.text()).toBe("");
  }
  expect((await target.fetch("/v8/artifacts/abc")).status).toBe(401);
  expect((await target.fetch("/api/auth/token", { method: "OPTIONS" })).status).toBe(404);
});
