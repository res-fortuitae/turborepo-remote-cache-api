import { describe } from "bun:test";
import { describeContract } from "./support/contract.ts";
import { describePermissionMatrix } from "./support/permission-matrix.ts";
import { httpTarget, uniqueTeam } from "./support/target.ts";
import { testTurboRoundTrip } from "./support/turbo.ts";

/**
 * Runs the shared suites against an already-running Worker: `bun run dev`
 * (local R2/D1/KV under workerd) or any deployed stage. Skipped unless
 * TURBO_API and TURBO_TOKEN are set; see `bun run test:live`.
 */
const api = Bun.env.TURBO_API;
const token = Bun.env.TURBO_TOKEN;

describe.skipIf(!api || !token)(`API at ${api ?? "TURBO_API"}`, () => {
  const target = () => httpTarget(api ?? "", token ?? "");

  describeContract(target, uniqueTeam("contract"));
  describePermissionMatrix(target, uniqueTeam("matrix"));
  testTurboRoundTrip(() => ({ api: api ?? "", token: token ?? "" }));
});
