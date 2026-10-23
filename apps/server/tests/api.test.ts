import { afterAll, describe, expect, test } from "bun:test";
import { describeContract } from "./support/contract.ts";
import { inProcessTarget, memoryBucket, serveInProcess } from "./support/in-process.ts";
import { describePermissionMatrix } from "./support/permission-matrix.ts";
import { bearer, uniqueTeam } from "./support/target.ts";
import { testTurboRoundTrip } from "./support/turbo.ts";

const token = "unit-test-token";

describe("API (in-process, memory bucket)", () => {
  const target = inProcessTarget(token);

  describeContract(() => target, uniqueTeam("unit"));
  describePermissionMatrix(() => target, uniqueTeam("matrix"));

  // Deployed Workers serve unknown paths from dashboard assets instead.
  test("rejects routes outside the cache API", async () => {
    expect((await target.fetch("/v9/artifacts/status", { headers: bearer(token) })).status).toBe(
      404,
    );
  });

  test("maps storage failures to 500 without leaking details", async () => {
    const bucket = memoryBucket();
    const failing = inProcessTarget(token, bucket);
    bucket.failing = true;

    const response = await failing.fetch("/v8/artifacts/abc", { headers: bearer(token) });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "internal_error", message: "Storage error" });
  });

  test("rejects before touching storage when unauthenticated", async () => {
    const bucket = memoryBucket();
    const target = inProcessTarget(token, bucket);
    bucket.failing = true;

    expect((await target.fetch("/v8/artifacts/abc", { method: "PUT", body: "x" })).status).toBe(
      401,
    );
    expect(bucket.objects.size).toBe(0);
  });
});

describe("turbo against the in-process API", () => {
  const server = serveInProcess(token);
  afterAll(() => server.stop(true));

  testTurboRoundTrip(() => ({ api: server.url.origin, token }));
});
