/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun drives the mocked control-plane boundary. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeLifecycleMutation } from "./retention-rules.ts";

test("concurrent bucket mutations preserve both rules and release the lock after failure", async () => {
  let rules: { id: string }[] = [];
  let fail = true;
  const mutate = makeLifecycleMutation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (fail) {
          fail = false;
          return Response.json({}, { status: 503 });
        }
        if (init?.method === "PUT") {
          rules = JSON.parse(String(init.body)).rules;
          return Response.json({ success: true });
        }
        const snapshot = structuredClone(rules);
        await Promise.resolve();
        return Response.json({ success: true, result: { rules: snapshot } });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const input = {
    accountId: "test",
    bucketName: "test",
    token: "test",
    projectId: "a",
    prefix: "org/a/",
    days: 1,
  };
  expect(await Effect.runPromise(mutate(input))).toBe(false);
  expect(
    await Effect.runPromise(
      Effect.all([mutate(input), mutate({ ...input, projectId: "b", prefix: "org/b/" })], {
        concurrency: "unbounded",
      }),
    ),
  ).toEqual([true, true]);
  expect(rules.map((rule) => rule.id).sort()).toEqual(["project-a", "project-b"]);
  expect(
    await Effect.runPromise(
      mutate({ accountId: "test", bucketName: "test", token: "test", projectId: "a" }),
    ),
  ).toBe(true);
  expect(rules.map((rule) => rule.id)).toEqual(["project-b"]);
});
