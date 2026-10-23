import { defineConfig } from "oxfmt";
import { ignorePatterns } from "./ignores.ts";

export default defineConfig({
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  ignorePatterns: [...ignorePatterns, "**/bun.lock", "**/uv.lock", "**/skills-lock.json"],
});
