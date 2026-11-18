import { expect, test } from "bun:test";
import { requireDestroyStage } from "../apps/server/scripts/alchemy-stage.ts";

test("destroy requires a valid and unambiguous stage option", () => {
  for (const args of [
    [],
    ["--stage"],
    ["--stage="],
    ["--stage", "--yes"],
    ["--", "--stage", "staging"],
    ["--stage", "staging", "--stage=production"],
  ]) {
    expect(() => requireDestroyStage(args)).toThrow(
      "Destroy requires exactly one explicit --stage",
    );
  }

  expect(requireDestroyStage(["--stage", "production"])).toEqual(["--stage", "production"]);
  expect(requireDestroyStage(["--stage=preview-test", "--yes"])).toEqual([
    "--stage",
    "preview-test",
    "--yes",
  ]);
});
