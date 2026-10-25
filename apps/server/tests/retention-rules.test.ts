/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun drives the external HTTP adapter. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeRetentionRules } from "../src/retention-rules.ts";

test("native retention preserves unrelated rules, applies prefix and updates changed days", async () => {
  const preserved = {
    id: "abort-stale-multipart-uploads",
    enabled: true,
    conditions: { prefix: "" },
    abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } },
  };
  const writes: unknown[] = [];
  const adapter = makeRetentionRules({
    accountId: "account",
    bucketName: "bucket",
    jurisdiction: "eu",
    token: () => Promise.resolve("private"),
    fetch: Object.assign(
      async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        expect(new Headers(init?.headers).get("cf-r2-jurisdiction")).toBe("eu");
        if (init?.method === "PUT") {
          writes.push(JSON.parse(String(init.body)));
          return Response.json({ success: true });
        }
        return Response.json({ success: true, result: { rules: [preserved] } });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  });
  expect(await Effect.runPromise(adapter.sync("a", "org/a/", 2))).toBe(true);
  expect(writes).toEqual([
    {
      rules: [
        preserved,
        {
          id: "project-a",
          enabled: true,
          conditions: { prefix: "org/a/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 172800 } },
        },
      ],
    },
  ]);
});

test("a full 1000-rule bucket falls back without overwriting any rules", async () => {
  let writes = 0;
  const adapter = makeRetentionRules({
    accountId: "account",
    bucketName: "bucket",
    token: () => Promise.resolve("private"),
    fetch: Object.assign(
      async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        if (init?.method === "PUT") writes++;
        return Response.json({
          success: true,
          result: { rules: Array.from({ length: 1000 }, (_, i) => ({ id: `other-${i}` })) },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  });
  expect(await Effect.runPromise(adapter.sync("a", "org/a/", 1))).toBe(false);
  expect(writes).toBe(0);
});
