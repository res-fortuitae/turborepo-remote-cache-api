# Shared tooling configuration

Copied from `~/Developer/listener/packages/config`, including all 52 custom rules,
framework overrides, upstream tests, licenses, and source provenance.

Consumers depend on `@repo/config: workspace:*` and use these config files:

```ts
// oxlint.config.mts
import { createOxlintConfig } from "@repo/config/oxlint";
export default createOxlintConfig(import.meta.url);
```

```ts
// oxfmt.config.mts
export { default } from "@repo/config/oxfmt";
```

All rule names, options, and warning severities match Listener. Effect checks also
apply to `apps/api`. React, accessibility, TanStack, Jest, and Playwright scopes
are retained for future consumers; add project roots in `frameworks.ts` as needed.
The configuration integration tests exercise currently present projects.

Formatting uses two spaces, double quotes, semicolons, trailing commas, and a
100-column width. Generated files, caches, and vendored snapshots are ignored;
Oxfmt also excludes lockfiles. Vendored source is preserved without reformatting.

Run `bun run lint`, `bun run format:check`, `bun run typecheck`, and `bun run test`
from the root. Turborepo caches type checks and tests with shared config inputs.
Run `bun run --cwd packages/config test` to run the copied suites directly.
See [vendor provenance](vendor/README.md) for snapshot commits and adaptations.
