import { expect, test } from "bun:test";
import { defineDeployConfig } from "../apps/server/src/deploy-config.ts";
import { localTestConfig } from "../apps/server/scripts/config.ts";
const config = defineDeployConfig({
  jurisdiction: "default",
  limits: { artifactRetentionDays: 30 },
  features: { edgeCache: true },
  stages: { production: "production", staging: "staging" },
});
test.each([
  ["1", "1", true],
  ["1", "0", false],
  ["1", undefined, false],
  [undefined, "1", false],
  [undefined, undefined, false],
])("legacy fixture is enabled only for explicit local tests (%s, %s)", (run, dev, enabled) => {
  expect(localTestConfig(config, run, dev).features.legacyToken === true).toBe(enabled);
  expect(config.features.legacyToken === true).toBe(false);
});
