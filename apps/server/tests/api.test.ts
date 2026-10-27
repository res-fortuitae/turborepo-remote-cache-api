import { afterAll, describe, expect, test } from "bun:test";
import { describeContract } from "./support/contract.ts";
import { inProcessTarget, memoryBucket, serveInProcess } from "./support/in-process.ts";
import { describePermissionMatrix } from "./support/permission-matrix.ts";
import { bearer, uniqueTeam } from "./support/target.ts";
import { turboRoundTrip, testTurboRoundTrip } from "./support/turbo.ts";

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
  test("real Turbo signs uploads and verifies downloaded artifacts", async () => {
    await turboRoundTrip(
      server.url.origin,
      token,
      undefined,
      0,
      "test-artifact-signature-key-at-least-32-bytes",
    );
  });
});

test("upload provenance is server-owned and is not returned as artifact response headers", async () => {
  const bucket = memoryBucket();
  const target = inProcessTarget(token, bucket);
  const uploaded = await target.fetch("/v8/artifacts/abc?teamId=provenance", {
    method: "PUT",
    headers: {
      ...bearer(token),
      "content-length": "1",
      "x-artifact-credential-id": "spoof",
      "x-artifact-uploaded-at": "1970-01-01",
      "x-artifact-duration": "42",
    },
    body: "x",
  });
  expect(uploaded.status).toBe(202);
  const meta = bucket.objects.get("provenance/abc")?.customMetadata;
  expect(meta).toMatchObject({ credentialType: "legacy", credentialId: "legacy", duration: "42" });
  expect(Date.parse(meta!.uploadedAt!)).toBeGreaterThan(Date.now() - 60_000);
  const downloaded = await target.fetch("/v8/artifacts/abc?teamId=provenance", {
    headers: bearer(token),
  });
  expect(downloaded.headers.get("credentialId")).toBeNull();
  expect(downloaded.headers.get("x-artifact-credential-id")).toBeNull();
});
