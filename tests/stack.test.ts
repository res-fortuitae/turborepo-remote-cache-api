import { describe } from "bun:test";
import * as Cloudflare from "alchemy/Cloudflare";
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
  state: Cloudflare.state(),
  dev: true,
});

describe.skipIf(!enabled)(`stack (${local ? "local" : "deployed"})`, () => {
  let api = "";

  if (enabled) {
    const outputs = beforeAll(deploy(Stack), { timeout: 600_000 });

    beforeAll(
      Effect.gen(function* () {
        const { url } = yield* outputs;

        if (!url) return yield* Effect.die(new Error("Stack did not output a Worker url"));
        api = url;
        // Ride out workers.dev propagation on a fresh deploy.
        yield* Test.getWhenReady(`${url}/v8/artifacts/status`);
      }),
    );

    afterAll.skipIf(Bun.env.NO_DESTROY === "1")(destroy(Stack), { timeout: 600_000 });
  }

  const target = () => httpTarget(api, token);

  describeContract(target, uniqueTeam("stack"));
  describePermissionMatrix(target, uniqueTeam("stack-matrix"));
  testTurboRoundTrip(() => ({ api, token }));
});
