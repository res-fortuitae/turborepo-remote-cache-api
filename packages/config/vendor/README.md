# Vendored Oxlint rules

This directory contains all rule implementations, helper modules, plugin entry
points, and tests from these snapshots:

- [T3 Code](https://github.com/pingdotgg/t3code/tree/2c8bdf6177159d8fcd12a897d7c9311f6eb93237/oxlint-plugin-t3code):
  29 rules, under `t3code/`.
- [anti-slop](https://github.com/dmmulroy/anti-slop/tree/13909c9e07590f5a85d93c62712259fe14a883f7/src):
  18 generic rules and 5 Effect rules, under `anti-slop/`.

`upstream.json` records the source commits and SHA-256 digest of every source
file. All 52 rule implementations and their runtime helpers are unchanged.
The original MIT licenses are included in each plugin directory. Anti-slop's
vendored eslint-stylistic code retains its own license and upstream notice.

Local test integration:

- This workspace declares `jsdom` as a test dependency because Vitest detects
  the environment pragma fixture inside `no-dom-test-environment.test.ts`.

- T3 Code's package and TypeScript manifests have `.upstream` suffixes so they
  do not create a nested workspace package or reference its original monorepo.
- The original T3 Code tests and test utility remain intact. Our Vitest config
  aliases their `@effect/vitest` test declarations to Vitest and their fixture
  utility to `tests/t3code-harness.ts`. The adapter invokes the installed Oxlint
  directly rather than requiring T3 Code's Vite+ and Effect test infrastructure.
  Test cases, options, and diagnostic assertions are preserved.
- Anti-slop's spacing CLI test invokes the installed Oxlint through Node instead
  of `pnpm exec`. Its assertions and fixtures are unchanged. All other anti-slop
  source and test files are unchanged.

Run `bun run --cwd packages/config test` to execute both upstream suites, check
source completeness, and test plugin loading through every consumer config.
Vendored files are excluded from normal linting and formatting to preserve the
upstream snapshots and avoid linting rule fixtures as application code.

To update, retrieve both source directories at explicit commits, compare all
rule exports, preserve these test-runner adaptations and licenses, update
`upstream.json`, enable any added rules in `../oxlint.ts`, and rerun the suites.
