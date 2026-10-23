import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { OxlintConfig, OxlintOverride } from "oxlint";

export const corePlugins: NonNullable<OxlintConfig["plugins"]> = [
  "eslint",
  "typescript",
  "unicorn",
  "oxc",
  "import",
  "promise",
];

const require = NodeModule.createRequire(import.meta.url);
const workspaceRoot = NodeURL.fileURLToPath(new NodeURL.URL("../../", import.meta.url));
const source = "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const test = "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";
const reactProjects = ["apps/web", "apps/mobile", "packages/client-core"];

const effectProjects = [
  "apps/api",
  "apps/worker",
  "packages/acatalog",
  "packages/notifications",
  "packages/notification-email",
  "packages/process-durable-object",
  "packages/notebook-durable-object",
  "packages/stream-registry",
];

export const frameworkOverrides = (configUrl: string | URL): OxlintOverride[] => {
  const configDirectory = NodePath.dirname(NodeURL.fileURLToPath(configUrl));

  const files = (projects: string[], pattern = source) =>
    projects.map((project) => {
      const relative = NodePath.relative(
        configDirectory,
        NodePath.join(workspaceRoot, project),
      ).replaceAll("\\", "/");

      return relative ? `${relative}/${pattern}` : pattern;
    });

  return [
    {
      files: files(reactProjects),
      plugins: [...corePlugins, "react"],
      rules: {
        "react/rules-of-hooks": "warn",
        "react/exhaustive-deps": "warn",
        "react/jsx-key": "warn",
        "react/jsx-no-duplicate-props": "warn",
        "react/jsx-no-undef": "warn",
        "react/no-direct-mutation-state": "warn",
        "react/no-string-refs": "warn",
        "react/no-danger-with-children": "warn",
        "react/immutability": "warn",
        "react/purity": "warn",
        "react/refs": "warn",
        "react/set-state-in-render": "warn",
        "react/set-state-in-effect": "warn",
        "react/static-components": "warn",
      },
    },
    {
      files: files(["apps/web"]),
      plugins: [...corePlugins, "jsx-a11y"],
      rules: {
        "jsx-a11y/alt-text": "warn",
        "jsx-a11y/anchor-has-content": "warn",
        "jsx-a11y/anchor-is-valid": [
          "warn",
          { components: ["Link"], specialLink: ["to"], aspects: ["invalidHref", "preferButton"] },
        ],
        "jsx-a11y/aria-props": "warn",
        "jsx-a11y/aria-proptypes": "warn",
        "jsx-a11y/aria-role": "warn",
        "jsx-a11y/aria-unsupported-elements": "warn",
        "jsx-a11y/click-events-have-key-events": "warn",
        "jsx-a11y/heading-has-content": "warn",
        "jsx-a11y/html-has-lang": "warn",
        "jsx-a11y/iframe-has-title": "warn",
        "jsx-a11y/label-has-associated-control": "warn",
        "jsx-a11y/no-autofocus": "warn",
        "jsx-a11y/no-static-element-interactions": "warn",
      },
    },
    {
      files: files(reactProjects),
      jsPlugins: [
        { name: "tanstack-query", specifier: require.resolve("@tanstack/eslint-plugin-query") },
      ],
      rules: {
        "tanstack-query/exhaustive-deps": "warn",
        "tanstack-query/no-rest-destructuring": "warn",
        "tanstack-query/stable-query-client": "warn",
        "tanstack-query/no-unstable-deps": "warn",
        "tanstack-query/infinite-query-property-order": "warn",
        "tanstack-query/mutation-property-order": "warn",
      },
    },
    {
      files: files(["apps/web"]),
      jsPlugins: [
        { name: "tanstack-router", specifier: require.resolve("@tanstack/eslint-plugin-router") },
      ],
      rules: {
        "tanstack-router/create-route-property-order": "warn",
        "tanstack-router/route-param-names": "warn",
      },
    },
    {
      files: files(effectProjects),
      jsPlugins: [{ name: "effect", specifier: require.resolve("@shekohex/oxc-effect") }],
      rules: {
        "effect/no-effect-gen-callback-alias": "warn",
        "effect/no-effect-fn-callback-alias": "warn",
        "effect/no-effect-all-step-sequencing": "warn",
        "effect/no-throw-in-effect-generator": "warn",
        "effect/no-schema-sync-in-effect-generator": "warn",
        "effect/require-return-yield-effect-terminal": "warn",
      },
    },
    {
      files: files(["apps/web", "packages/client-core", "packages/config"], test),
      excludeFiles: files(["apps/web"], "src/server/**"),
      plugins: [...corePlugins, "vitest"],
      rules: {
        "vitest/no-focused-tests": "warn",
        "vitest/no-disabled-tests": "warn",
        "vitest/valid-expect": "warn",
        "vitest/valid-describe-callback": "warn",
        "vitest/valid-expect-in-promise": "warn",
        "vitest/no-conditional-expect": "warn",
        "vitest/require-awaited-expect-poll": "warn",
      },
    },
    {
      files: [...files(["apps/mobile"], "__tests__/**/*.{js,jsx,ts,tsx}")],
      plugins: [...corePlugins, "jest"],
      rules: {
        "jest/no-focused-tests": "warn",
        "jest/no-disabled-tests": "warn",
        "jest/valid-expect": "warn",
        "jest/valid-describe-callback": "warn",
        "jest/no-identical-title": "warn",
      },
    },
    {
      files: [
        ...files(effectProjects, test),
        ...files(["apps/web"], "src/server/**/*.test.ts"),
        ...files(["apps/mobile"], "src/**/*.test.{ts,tsx}"),
      ],
      rules: {
        "eslint/no-restricted-properties": [
          "warn",
          {
            object: "test",
            property: "only",
            message: "Remove focused Bun tests before committing.",
          },
          {
            object: "it",
            property: "only",
            message: "Remove focused Bun tests before committing.",
          },
          {
            object: "describe",
            property: "only",
            message: "Remove focused Bun suites before committing.",
          },
        ],
      },
    },
    {
      files: files(["apps/web"], "e2e/**/*.spec.{ts,tsx}"),
      jsPlugins: [{ name: "playwright", specifier: require.resolve("eslint-plugin-playwright") }],
      rules: {
        "playwright/missing-playwright-await": ["warn", { includePageLocatorMethods: true }],
        "playwright/no-focused-test": "warn",
        "playwright/no-force-option": "warn",
        "playwright/no-page-pause": "warn",
        "playwright/no-wait-for-timeout": "warn",
        "playwright/prefer-web-first-assertions": "warn",
        "playwright/valid-expect": "warn",
      },
    },
  ];
};
