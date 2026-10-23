import * as NodeURL from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@effect/vitest", replacement: "vitest" },
      {
        find: "../test/utils.ts",
        replacement: NodeURL.fileURLToPath(
          new NodeURL.URL("./tests/t3code-harness.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "vendor/t3code/rules/*.test.ts"],
    maxWorkers: 3,
    testTimeout: 15_000,
  },
});
