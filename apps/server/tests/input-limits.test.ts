import { expect, test } from "bun:test";
import { inProcessTarget, inProcessHandler } from "./support/in-process.ts";
const target = inProcessTarget("limits");
const headers = { authorization: "Bearer limits" };
test("bounds artifact JSON before decoding", async () => {
  for (const path of ["", "/events"]) {
    const response = await target.fetch(`/v8/artifacts${path}`, {
      method: "POST",
      headers,
      body: " ".repeat(20_000_000) + (path ? "[]" : '{"hashes":[]}'),
    });
    expect(response.status).toBe(413);
  }
});
test("bounds hashes and metadata and canonicalizes case", async () => {
  for (const length of [1, 256, 257, 2000]) {
    const response = await target.fetch(`/v8/artifacts/${"a".repeat(length)}`, {
      method: "PUT",
      headers: { ...headers, "content-length": "1" },
      body: "x",
    });
    expect(response.status).toBe(length <= 256 ? 202 : 400);
  }
  expect(
    (
      await target.fetch("/v8/artifacts/AbC", {
        method: "PUT",
        headers: { ...headers, "content-length": "1" },
        body: "x",
      })
    ).status,
  ).toBe(202);
  expect((await target.fetch("/v8/artifacts/abc", { headers })).status).toBe(200);
  expect(
    (
      await target.fetch("/v8/artifacts/def", {
        method: "PUT",
        headers: { ...headers, "content-length": "1", "x-artifact-tag": "a".repeat(10_000) },
        body: "x",
      })
    ).status,
  ).toBe(400);
});
test("bounds event count and strings", async () => {
  const event = { sessionId: "s", hash: "abc", source: "REMOTE", event: "HIT" };
  for (const body of [Array(1001).fill(event), [{ ...event, sessionId: "s".repeat(257) }]]) {
    expect(
      (
        await target.fetch("/v8/artifacts/events", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400);
  }
});
test("stops consuming an oversized chunked body", async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(60_000).fill(32));
      if (reads === 100) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await inProcessHandler("limits")(
    new Request("http://localhost/v8/artifacts", { method: "POST", headers, body }),
  );
  expect(response.status).toBe(413);
  expect(reads).toBeLessThan(10);
  expect(cancelled).toBe(true);
});
test("rejects each oversized metadata header and aggregate metadata", async () => {
  const cases: Record<string, string>[] = [
    { "x-artifact-tag": "a".repeat(10_000) },
    { "x-artifact-sha": "a".repeat(10_000) },
    { "x-artifact-dirty-hash": "a".repeat(10_000) },
    { "x-artifact-duration": "1".repeat(10_000) },
    { "x-artifact-tag": "a".repeat(3100), "x-artifact-sha": "b".repeat(3100) },
  ];
  for (const metadata of cases) {
    expect(
      (
        await target.fetch("/v8/artifacts/def", {
          method: "PUT",
          headers: { ...headers, ...metadata, "content-length": "1" },
          body: "x",
        })
      ).status,
    ).toBe(400);
  }
});
test("preserves query keys while using canonical storage hashes", async () => {
  const response = await target.fetch("/v8/artifacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ hashes: ["AbC", "abc", "not-hex"] }),
  });
  const result = await response.json();
  expect(result).toEqual({
    AbC: { size: 1, taskDurationMs: 0 },
    abc: { size: 1, taskDurationMs: 0 },
    "not-hex": { error: { message: "Invalid hash" } },
  });
});
