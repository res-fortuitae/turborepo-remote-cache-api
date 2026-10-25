import { describe, expect, test } from "bun:test";
import { bearer, type Target } from "./target.ts";

/**
 * Turborepo remote cache HTTP contract, formerly `tests/curl.sh`. Every case
 * is independent apart from the shared upload, which runs first.
 */
export const describeContract = (target: () => Target, team: string) =>
  describe("HTTP contract", () => {
    const artifact = "cache migration artifact\n";
    const base = "/v8/artifacts";

    const request = (path: string, init: RequestInit = {}) => {
      const { fetch, token } = target();
      const headers = new Headers(init.headers);

      if (!headers.has("Authorization")) {
        for (const [key, value] of Object.entries(bearer(token))) headers.set(key, value);
      }

      return fetch(path, { ...init, headers });
    };

    const json = (body: string) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    test("status requires a bearer token", async () => {
      const { fetch } = target();
      expect((await fetch(`${base}/status`)).status).toBe(401);
      expect(
        (await fetch(`${base}/status`, { headers: { Authorization: "Bearer invalid" } })).status,
      ).toBe(401);
    });

    test("status reports caching enabled", async () => {
      const response = await request(`${base}/status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "enabled" });
    });

    test("rejects bad hashes, teams, and methods", async () => {
      expect((await request(`${base}/not-a-hash?teamId=${team}`)).status).toBe(400);
      expect((await request(`${base}/status?teamId=invalid%2Fteam`)).status).toBe(400);
      expect((await request(`${base}/deadbeef?teamId=${team}`, { method: "DELETE" })).status).toBe(
        405,
      );
    });

    test("uploads and restores an artifact with metadata", async () => {
      expect((await request(`${base}/deadbeef?teamId=${team}`)).status).toBe(404);

      const upload = await request(`${base}/deadbeef?teamId=${team}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-artifact-duration": "42",
          "x-artifact-tag": "migration",
        },
        body: artifact,
      });

      expect(upload.status).toBe(202);
      expect(await upload.json()).toEqual({
        urls: [expect.stringMatching(/\/v8\/artifacts\/deadbeef$/)],
      });

      const head = await request(`${base}/deadbeef?teamId=${team}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("x-artifact-duration")).toBe("42");
      expect(head.headers.get("x-artifact-tag")).toBe("migration");

      const download = await request(`${base}/deadbeef?teamId=${team}`);
      expect(download.status).toBe(200);
      expect(download.headers.get("x-artifact-tag")).toBe("migration");
      expect(await download.text()).toBe(artifact);

      const bySlug = await request(`${base}/deadbeef?slug=${team}`);
      expect(bySlug.status).toBe(200);
      expect(await bySlug.text()).toBe(artifact);
    });

    test("isolates artifacts per team", async () => {
      expect((await request(`${base}/deadbeef?teamId=${team}-other`)).status).toBe(404);
    });

    test("rejects invalid upload headers", async () => {
      const response = await request(`${base}/abcdef?teamId=${team}`, {
        method: "PUT",
        headers: { "x-artifact-duration": "soon" },
        body: "x",
      });

      expect(response.status).toBe(400);
    });

    test("queries artifact metadata", async () => {
      const response = await request(
        `${base}?teamId=${team}`,
        json(JSON.stringify({ hashes: ["deadbeef", "cafe", "nope!"] })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        deadbeef: { size: artifact.length, taskDurationMs: 42, tag: "migration" },
        cafe: null,
        "nope!": { error: { message: "Invalid hash" } },
      });
      expect((await request(`${base}?teamId=${team}`, json("{}"))).status).toBe(400);
    });

    test("records cache events", async () => {
      const events = [{ sessionId: "migration", source: "REMOTE", event: "HIT", hash: "deadbeef" }];
      expect(
        (await request(`${base}/events?teamId=${team}`, json(JSON.stringify(events)))).status,
      ).toBe(200);
      expect((await request(`${base}/events?teamId=${team}`, json("{}"))).status).toBe(400);
    });
  });
