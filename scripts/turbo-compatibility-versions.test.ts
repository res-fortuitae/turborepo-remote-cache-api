import { expect, test } from "bun:test";
import { documentsCompatibilityVersion } from "./turbo-compatibility-versions.ts";

test("the workflow matrix and docs must both list the exact Turbo version", () => {
  const workflow = (version: string) => `
jobs:
  matrix:
    strategy:
      matrix:
        turbo: [${version}]
# A comment mentioning 2.11.1 is irrelevant.
`;
  const docs = (version: string) => `| ${version} | Supported |\n`;

  expect(documentsCompatibilityVersion(workflow("2.11.1"), docs("2.11.1"), "2.11.1")).toBe(true);
  expect(documentsCompatibilityVersion(workflow("2.11.10"), docs("2.11.1"), "2.11.1")).toBe(false);
  expect(documentsCompatibilityVersion(workflow("2.11.1"), docs("2.11.10"), "2.11.1")).toBe(false);
});
