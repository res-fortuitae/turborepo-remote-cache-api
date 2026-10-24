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
          expect(basinDisabledReason).toContain("no local resource provider");
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
    expect(await response.text()).toContain("Turborepo Remote Cache");
  });

  test("builds authentication with the Secrets Store binding", async () => {
    const response = await target().fetch("/api/auth/ok");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  describeContract(target, uniqueTeam("stack"));
  describePermissionMatrix(target, uniqueTeam("stack-matrix"));
  testTurboRoundTrip(() => ({ api, token }));
});
