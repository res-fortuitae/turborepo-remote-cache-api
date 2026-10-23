---
status: accepted
---

# Better Auth on Workers: composition, storage and known gaps

`@repo/auth` wraps Better Auth 1.7 as the `Auth` service. `AuthLive` needs `Database`,
`AuthConfig` (from `@repo/deploy-config`), `Mailer` and `AuditLog`, and uses
`SecondaryStorage` when it's provided. The Worker serves `/api/auth/*` through
`Auth.handler`. This records what
[STV-432](https://linear.app/stvyas-workspace/issue/STV-432) found while proving the
integration. Plugin configuration belongs to the sub-issues.

## Decisions

**One instance per request.** Alchemy resolves the D1 and KV bindings per request,
so the Worker builds the auth layer per request. Building the instance and serving
`/api/auth/ok` takes about 0.3 ms (Bun, warm), so caching per isolate isn't worth
the mutable singleton ADR 0001 forbids.

**Drizzle handle.** Better Auth's `drizzleAdapter` needs the Drizzle instance itself
(`db._.fullSchema`, `db.query`), not `Database.query`. `DatabaseService.drizzle`
exposes it for library adapters only. Domain code keeps using `query` and `batch`.
The SQLite adapter path never calls `db.transaction`, so `transaction: false` is
safe on D1.

**Storage**, following [ADR 0002](./0002-storage-consistency-rules.md):

- Sessions: KV `secondaryStorage` with `session.storeSessionInDatabase: true`.
  On a KV miss Better Auth reads D1. The cookie cache stays off, since it would add
  a second revocation lag.
- Verification tokens and device codes: `verification.storeInDatabase: true`, so
  single-use values are consumed atomically in D1.
- Rate limiting: `rateLimit.storage: "database"`. Better Auth increments with a
  conditional `count + 1` update, which is atomic in D1. Auth may not import
  `@repo/ratelimit`. Better Auth's `customStorage` is an atomic `consume(key, window,
  max)`, so STV-446 can route it to the Rate Limiting binding through an auth-owned
  tag. Note that the binding has one period and limit per namespace, not per rule.
- `SecondaryStorageLive` wraps an auth-owned `AuthKvNamespace`. It prefixes keys
  with `auth:` and raises TTLs to KV's 60-second minimum. Read and write failures
  count as a miss. Delete failures are surfaced so a sign-out can't silently leave
  a cached session behind.

**Sensitive actions** call `Auth.requireFreshSession`. It resolves the session as
usual, then requires a live row for that token in D1.

## Blockers and gaps

1. **Better Auth expects atomic secondary storage.** Its 1.7 `SecondaryStorage`
   interface requires `getAndDelete` and `increment`, which KV can't do atomically.
   With the options above Better Auth never calls them. The KV adapter rejects
   both, so a plugin that needs them fails loudly instead of racing. Plugins that
   reserve verification values (`reserveVerificationValue`) also need
   `verification.storeInDatabase`, which is already on.
2. **Better Auth's own sensitive endpoints trust KV.** `sensitiveSessionMiddleware`
   (revoke-session, change-password, delete-user) only bypasses the cookie cache. It
   still reads KV first, so for about 60 s after a sign-out elsewhere these endpoints
   can accept a revoked session. App-level sensitive actions use
   `requireFreshSession`. Closing the gap for Better Auth's endpoints needs a
   `hooks.before` D1 check on those paths. That belongs with STV-481/STV-511, which
   add the admin and passkey endpoints.
3. **A stale KV session that needs a refresh fails closed.** If KV still holds a
   session that D1 has deleted and the session is due for its `updateAge` refresh,
   Better Auth's D1 update finds no row and the request fails ("Failed to get
   session"). This is safe but returns a 500 instead of a 401 until KV catches up.
4. **Hooks can't join a caller's D1 batch.** `databaseHooks` (and the organization
   hooks) run around adapter calls that execute immediately. D1 has no interactive
   transactions, and the adapter exposes no way to defer a statement into
   `Database.batch`. Transactional audit for Better Auth writes (STV-458)
   therefore can't share an atomic batch with the auth write. It needs an outbox
   row written from an `after` hook plus reconciliation (STV-482), or a
   compensating check.
5. **`nodejs_compat`.** Better Auth loads `AsyncLocalStorage` from
   `node:async_hooks` through `process.getBuiltinModule`, which Workers expose only
   with `nodejs_compat`. The Worker now sets that flag. Other `node:` references in
   the bundle (`node:crypto`, `node:sqlite`) are guarded dynamic loads. The auth
   bundle with Effect and Drizzle is about 1.0 MB minified, 274 KB gzipped.

## Consequences

- Schema-affecting options are duplicated in `packages/db/scripts/auth-schema.config.ts`
  because db may not import auth. `@repo/auth`'s schema test fails when Better
  Auth needs a table or column that `@repo/db` lacks. Plugin issues regenerate
  with `bun run --cwd packages/db db:auth:generate` and `bun run db:generate`.
- `Mailer` and `AuditLog` start as no-op layers (`MailerNoop`, `AuditLogNoop`)
  until STV-495 and STV-457 implement them.
- `@repo/oidc` and `@repo/auth` each define a small `KvStore` interface and
  namespace tag. ADR 0001 has no package both may import for runtime KV adapters.
  Sharing one needs a new low-level package and an ADR 0001 revision.
