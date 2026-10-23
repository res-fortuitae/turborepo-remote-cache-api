# Agent Instructions

- Read `README.md` before changing the workspace.
- Use Bun for dependencies and package scripts. Apps live in `apps/*`; shared packages live in `packages/*`.
- Keep Worker source in `apps/server`, shared contracts in `packages/shared`, and the single Alchemy composition root, environment files, and local Alchemy state at the repository root. Run `dev`, `deploy`, and `destroy` from the root scripts. Deploy or destroy infrastructure only when explicitly requested.
- Shared Oxlint and Oxfmt rules live in `packages/config`. Preserve vendored source, licenses, and provenance; see `packages/config/vendor/README.md`.
- Run `bun run check` and `bun run test` after changing workspace configuration or shared rules.

## Working in this workspace

- When you're assigned a Linear ticket to implement, the very first step is to create a branch following our Linear branch naming convention and update the issue status to 'In Progress' (or another appropriate status) before you start working. Throughout the process, add relevant comments to the ticket regarding your progress, notes, validation details, or any blockers. Once you finish the implementation, leave a final comment on the issue, commit your code to the repository, and open a Pull Request ready for review.
- In all of your comments you need to detail which model , agent , harness are you currently using as well and current timestamp.
