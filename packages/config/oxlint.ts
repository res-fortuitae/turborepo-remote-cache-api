import * as NodeURL from "node:url";
import { defineConfig } from "oxlint";
import { corePlugins, frameworkOverrides } from "./frameworks.ts";
import { ignorePatterns } from "./ignores.ts";

const base = defineConfig({
  plugins: corePlugins,
  categories: { correctness: "warn" },
  ignorePatterns,
  jsPlugins: [
    {
      name: "t3code",
      specifier: NodeURL.fileURLToPath(
        new NodeURL.URL("./vendor/t3code/index.ts", import.meta.url),
      ),
    },
    {
      name: "anti-slop",
      specifier: NodeURL.fileURLToPath(
        new NodeURL.URL("./vendor/anti-slop/index.ts", import.meta.url),
      ),
    },
    {
      name: "anti-slop-effect",
      specifier: NodeURL.fileURLToPath(
        new NodeURL.URL("./vendor/anti-slop/effect/index.ts", import.meta.url),
      ),
    },
  ],
  rules: {
    "oxc/no-accumulating-spread": "warn",
    "t3code/namespace-node-imports": "warn",
    "t3code/no-dom-test-environment": "warn",
    "t3code/no-em-dash-copy": "warn",
    "t3code/no-frame-waits-in-browser-tests": "warn",
    "t3code/no-global-process-runtime": "warn",
    "t3code/no-hermes-unsupported-apis": "warn",
    "t3code/no-hookless-use-function": "warn",
    "t3code/no-inline-schema-compile": "warn",
    "t3code/no-low-value-comments": "warn",
    "t3code/no-manual-effect-runtime-in-tests": "warn",
    "t3code/no-manual-memo": "warn",
    "t3code/no-mobile-uniwind-theme-escape-hatches": "warn",
    "t3code/no-mobile-pull-request-glyph-literals": "warn",
    "t3code/no-native-title-tooltip": "warn",
    "t3code/no-outset-state-indicators": "warn",
    "t3code/no-polling-loop-in-tests": "warn",
    "t3code/no-raw-mcp-registration": "warn",
    "t3code/no-raw-resize-observer": "warn",
    "t3code/no-real-time-wait-in-tests": "warn",
    "t3code/no-test-in-loop": "warn",
    "t3code/no-test-timeout-or-unreasoned-skip": "warn",
    "t3code/no-rpc-permission-bypass": "warn",
    "t3code/no-unscoped-has": "warn",
    "t3code/no-wall-clock-in-tests": "warn",
    "t3code/prefer-catch-tags": "warn",
    "t3code/prefer-effect-fn": "warn",
    "t3code/require-centered-scroll-gutter": "warn",
    "t3code/require-disposable-render": "warn",
    "t3code/require-suppression-reason": "warn",
    "anti-slop/no-array-filter-map": "warn",
    "anti-slop/no-reduce-accumulator-copy": "warn",
    "anti-slop/no-chained-type-assertions": "warn",
    "anti-slop/no-conditional-empty-object-spread": "warn",
    "anti-slop/no-known-value-widening": "warn",
    "anti-slop/no-module-mocking": "warn",
    "anti-slop/no-object-parameters": "warn",
    "anti-slop/no-reflect-apply": "warn",
    "anti-slop/no-reflect-get": "warn",
    "anti-slop/no-runtime-typeof": "warn",
    "anti-slop/no-unsafe-dictionary-type": "warn",
    "anti-slop/no-shape-in-symbol-names": "warn",
    "anti-slop/no-unknown-parameters": "warn",
    "anti-slop/no-unknown-returns": "warn",
    "anti-slop/no-unknown-type-aliases": "warn",
    "anti-slop/no-widen-then-assert": "warn",
    "anti-slop/require-readable-spacing": "warn",
    "anti-slop/require-safety-comment-for-type-assertion": "warn",
    "anti-slop-effect/no-manual-effect-error-tag": "warn",
    "anti-slop-effect/no-manual-tag-comparison": "warn",
    "anti-slop-effect/no-manual-tagged-construction": "warn",
    "anti-slop-effect/no-service-constructor-imports": "warn",
    "anti-slop-effect/prefer-effect-match": "warn",
  },
});

export const createOxlintConfig = (configUrl: string | URL) =>
  defineConfig({
    ...base,
    overrides: frameworkOverrides(configUrl),
  });

export default createOxlintConfig(new NodeURL.URL("../../oxlint.config.mts", import.meta.url));
