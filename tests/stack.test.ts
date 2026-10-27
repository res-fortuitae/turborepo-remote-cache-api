import { describe, expect, test } from "bun:test";
import * as Cloudflare from "alchemy/Cloudflare";
import { localState } from "alchemy";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";
import { describeContract } from "../apps/server/tests/support/contract.ts";
import { describePermissionMatrix } from "../apps/server/tests/support/permission-matrix.ts";
import { httpTarget, uniqueTeam } from "../apps/server/tests/support/target.ts";
import { testTurboRoundTrip } from "../apps/server/tests/support/turbo.ts";

/**
 * Deploys the real root stack with alchemy's `Test` harness and runs the
 * shared suites against it. Opt in with ALCHEMY_TEST=1 (`bun run test:stack`).
 *
 * By default the stack runs locally (workerd with local R2/D1/KV, the
 * `alchemy dev` topology) and needs no Cloudflare account. Set
 * ALCHEMY_TEST_DEV=0 (`bun run test:deployed`) to deploy a real stage, named
 * by ALCHEMY_TEST_STAGE (default `test_$USER`), destroyed afterwards.
 */
const enabled = Bun.env.ALCHEMY_TEST === "1";
const local = !["0", "false", "no", "off"].includes(Bun.env.ALCHEMY_TEST_DEV ?? "");
const token = Bun.env.TURBO_TOKEN ?? "";

const { deploy, destroy, beforeAll, afterAll } = Test.make({
  providers: Cloudflare.providers(),
  state: local ? localState() : Cloudflare.state(),
  dev: local,
});

describe.skipIf(!enabled)(`stack (${local ? "local" : "deployed"})`, () => {
  let api = "";

  if (enabled) {
    const outputs = beforeAll(deploy(Stack), { timeout: 600_000 });

    beforeAll(
      Effect.gen(function* () {
        const { url, bucketName, databaseId, cacheNamespaceId, basinDisabledReason } =
          yield* outputs;

        if (!url) return yield* Effect.die(new Error("Stack did not output a Worker url"));

        if (local) {
          expect(new URL(url).hostname).toBe("localhost");
          expect(bucketName.startsWith("dev:")).toBe(true);
          expect(databaseId.startsWith("dev:")).toBe(true);
          expect(cacheNamespaceId.startsWith("dev:")).toBe(true);
          expect(basinDisabledReason).toContain("local development");
        }

        api = url;
        // Ride out workers.dev propagation on a fresh deploy.
        yield* Test.getWhenReady(`${url}/v8/artifacts/status`);
      }),
    );

    afterAll.skipIf(Bun.env.NO_DESTROY === "1")(destroy(Stack), { timeout: 600_000 });
  }

  const target = () => httpTarget(api, token);

  test("serves dashboard assets through the Alchemy Worker", async () => {
    const response = await target().fetch("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Remote Cache dashboard");
  });

  test("builds authentication with the Secrets Store binding", async () => {
    const response = await target().fetch("/api/auth/ok");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("serves M5 health and protected token routes ahead of dashboard assets", async () => {
    const health = await target().fetch("/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    const report = await health.json();
    expect(report.healthy).toBe(true);
    expect(report.checks).toEqual({ d1: "ok", r2: "ok", kv: "ok", coordinator: "ok" });

    const response = await target().fetch("/tokens/dev", {
      method: "POST",
      headers: { origin: api, "content-type": "application/json" },
      body: JSON.stringify({ team: "test-org", project: "test-project" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "unauthenticated" });
  });

  test("issues D1-backed device codes to the CLI without a browser Origin", async () => {
    const response = await target().fetch("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "tcache", scope: "developer" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const code = await response.json();
    expect(code.expires_in).toBe(300);
    expect(code.interval).toBe(5);
    expect(new URL(code.verification_uri).origin).toBe(api);

    const polled = await target().fetch("/api/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "tcache",
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    expect(polled.status).toBe(400);
    expect((await polled.json()).error).toBe("authorization_pending");
  });

  test("reports effective capabilities to doctor and rejects anonymous readers", async () => {
    expect((await target().fetch("/api/instance/capabilities")).status).toBe(401);

    const response = await target().fetch("/api/instance/capabilities", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = await response.json();
    expect(report.schemaVersion).toBe(1);

    if (local) {
      expect(report.workersPlan).toBe("local");
      expect(report.analyticsMode).toBe("lite");
      expect(report.auditHistory.enabled).toBe(false);
    }
  });

  describeContract(target, uniqueTeam("stack"));
  describePermissionMatrix(target, uniqueTeam("stack-matrix"));
  testTurboRoundTrip(() => ({ api, token }));
});
