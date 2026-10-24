React dashboard using Bun HTML imports and the shared [shadcn Mira UI package](../../packages/ui/README.md).

From the repository root:

```sh
bun run dashboard:dev    # http://127.0.0.1:3000, UI preview with hot reload
bun run dashboard:build  # production HTML/CSS/JS and self-hosted fonts in dist/
```

The preview serves only the UI. Its displayed cache URL is the preview origin;
use your deployed API origin when testing actual cache requests. Root `dev`,
`plan`, and `deploy` build the dashboard before Alchemy and serve `dist/` through
the existing Worker assets binding on the API origin. Root `dev` builds once;
rebuild after UI changes for integrated Worker checks, or use `dashboard:dev`
for fast visual iteration. The build copies the security headers from `public/`.

Reusable components and tokens live in `packages/ui`; pages and product behavior
live here. The setup screen supports keyboard-operated environment tabs, copy
controls with error feedback, and persisted light/dark appearance (system default).
It shows no simulated workspace statistics. Authentication, organization switching,
typed data clients, and application routing remain in STV-466.

Run `bun run check` and `bun run test` at the repository root. Both dashboard and
UI TSX sources participate in workspace type checks, lint, and formatting.
