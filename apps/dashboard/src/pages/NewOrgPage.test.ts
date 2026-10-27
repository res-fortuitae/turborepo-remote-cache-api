import { expect, test } from "bun:test";
import { slugify } from "./NewOrgPage.tsx";

test("derives a Turbo team slug from an organization name", () => {
  expect(slugify("Globex Corp")).toBe("globex-corp");
  expect(slugify("  Ünïcode & Co!! ")).toBe("unicode-co");
  expect(slugify("x".repeat(80))).toHaveLength(48);
});
