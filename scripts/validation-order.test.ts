import { expect, test } from "bun:test";

test("validation checks committed Action artifacts before any build", async () => {
  const workflow = await Bun.file(
    new URL("../.github/workflows/validate.yml", import.meta.url),
  ).text();
  const check = workflow.indexOf("run: bun run --cwd packages/action check:bundle");
  const build = workflow.indexOf("run: bun run build");
  expect(check).toBeGreaterThan(-1);
  expect(build).toBeGreaterThan(check);
});
