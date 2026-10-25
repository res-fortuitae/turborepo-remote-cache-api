import { test, expect } from "bun:test";
import { adminPurge } from "./purge.ts";

test("admin purge defaults to preview, requires an existing job for confirmation, and refuses redirects", async () => {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetcher = async (url: URL, init: RequestInit) => {
    requests.push({ url, init });
    return Response.json({
      id: "j",
      state: "ready",
      count: 2,
      bytes: 20,
      removed: 0,
      removedBytes: 0,
    });
  };
  const env = { server: "https://cache.example.com", cookie: "session=fake" };
  expect((await adminPurge(["p", "--filter", '{"runId":"123"}'], env, fetcher)).count).toBe(2);
  expect(requests[0]?.url.pathname).toBe("/projects/p/purges");
  expect(requests[0]?.init).toMatchObject({
    method: "POST",
    redirect: "error",
    body: '{"runId":"123"}',
  });
  await expect(adminPurge(["p", "--confirm"], env, fetcher)).rejects.toThrow("Confirm");
  await adminPurge(["p", "--job", "j", "--confirm"], env, fetcher);
  expect(requests[1]?.url.pathname).toBe("/projects/p/purges/j/confirm");
  await expect(adminPurge(["p"], { ...env, server: "http://evil.test" }, fetcher)).rejects.toThrow(
    "HTTPS",
  );
});
