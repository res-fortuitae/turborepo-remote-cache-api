React dashboard using Bun HTML imports and the shared [shadcn Mira UI package](../../packages/ui/README.md).

From the repository root:

```sh
bun run dashboard:dev    # http://127.0.0.1:3000, UI preview with hot reload
bun run dashboard:build  # production HTML/CSS/JS and self-hosted fonts in dist/
bun run --cwd apps/dashboard test
```

The preview serves only the UI; API calls need the Worker. Root `dev`, `plan`, and
`deploy` build the dashboard before Alchemy and serve `dist/` through the Worker
assets binding on the API origin, so the dashboard and API share cookies and no
CORS is involved. Root `dev` builds once; rebuild and restart it after UI changes
for integrated checks. The build copies the security headers from `public/`.

## Structure

- `src/app.tsx`: session gate, org resolution and the route switch.
- `src/routes.tsx`: org routes (below `/orgs/:slug`) and instance routes.
- `src/lib/router.tsx`: hash router. Dashboard routes live in the URL hash
  (`/#/orgs/acme/projects`) because `/orgs/*`, `/projects/*` and `/instance/*` are
  Worker management APIs (listed in `DashboardAssets.runWorkerFirst`). A reload of
  a path route would reach JSON endpoints. `/device` is the only path route: the
  CLI prints it as the device verification URI (`/?view=device` still works).
- `src/lib/auth-client.ts`: Better Auth React client (session, organizations,
  groups, dynamic roles, admin, device authorization) on `/api/auth`.
- `src/lib/org.tsx`: the org on screen; it keeps Better Auth's active org in step
  with the URL so native org endpoints act on that org.
- `src/lib/api.ts`: same-origin JSON client. Responses are decoded with the shared
  Effect schemas re-exported from `@repo/shared`; errors become `ApiError` with the
  server's code and message.
- `src/lib/use-resource.ts`: load/reload state for a keyed request.
- `src/components`: shell (sidebar, org switcher, account menu, mobile sheet),
  brand mark and shared page primitives (headers, empty/error/loading states,
  copyable code).

Sidebar entries live in `src/lib/nav.ts`; instance entries only show for instance
owners, admins and auditors. UI gating is a convenience: the server enforces every
permission.

Reusable components and tokens live in `packages/ui`; pages and product behavior
live here. The design system adds a signal-green `brand` accent (cache hits, the
active location), `success`/`warning` status tokens and five chart colors to the
neutral Mira palette, in light and dark themes (system default, persisted toggle).

Run `bun run check` and `bun run test` at the repository root. Both dashboard and
UI TSX sources participate in workspace type checks, lint, and formatting.
