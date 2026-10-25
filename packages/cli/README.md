CLI package scaffold. Commands and executable distribution will be added in the CLI implementation tickets.

Run `bun run typecheck` here or `bun run check` at the repository root. Shared contracts are available through `@repo/shared`.

The capability-reporting part of `doctor --server` is implemented:

```sh
TURBO_API=https://cache.example.com TURBO_TOKEN='<token>' bun packages/cli/src/bin.ts doctor --server
```

Use `--server URL` to override `TURBO_API`, and `--json` for the versioned report.
Only HTTPS and loopback HTTP origins are accepted; redirects are rejected before
credentials can be forwarded. The remaining doctor checks and executable
distribution are pending STV-489.
