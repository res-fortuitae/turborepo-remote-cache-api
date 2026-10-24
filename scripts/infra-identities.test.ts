import { expect, test } from "bun:test";

test("the retained Coordinator keeps its host Worker and binding identities", async () => {
  const root = await Bun.file(new URL("../alchemy.run.ts", import.meta.url)).text();
  const worker = await Bun.file(new URL("../apps/server/src/worker.ts", import.meta.url)).text();

  const coordinator = await Bun.file(
    new URL("../packages/coordinator/src/durable-object.ts", import.meta.url),
  ).text();

  // These persisted names cannot change without an explicit data migration.
  expect(root).toContain('"TurborepoRemoteCache",');
  expect(root).toContain("retainStatefulResources(stage, config.stages)");
  expect(root).toContain("const worker = yield* Worker;");
  expect(worker).toMatch(/extends Cloudflare\.Worker<Api>\(\)\(\s*"Api",/);
  expect(worker).toContain("yield* Coordinator;");
  expect(coordinator).toContain('>()("Coordinator")');
});
