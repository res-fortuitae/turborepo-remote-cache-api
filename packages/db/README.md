# @repo/db

Database persistence for the Worker and domain packages. The runtime entry point
exports Effect 4 services, layers, schema and types. It never reads environment
bindings or imports Alchemy. Apps provide the raw D1 binding; repositories require
`Database` and can be composed independently.

```ts
import { D1Client, DatabaseLive, ProjectRepoLive } from "@repo/db";
import { Layer } from "effect";

const ProjectsLive = ProjectRepoLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(Layer.succeed(D1Client, bindings.Database)),
);
```

For Alchemy, bind `Cloudflare.D1.QueryDatabase(DatabaseResource)` during Worker
initialization and provide its `.raw` effect through `Layer.effect(D1Client, d1.raw)`
at the request boundary. Resolve the raw binding during a request, because Alchemy's
initialization also runs during planning. No connection is acquired at import time.
Apps consume repositories; schema/query construction belongs in domain packages.

`Database.query(operation, db => query)` suspends query construction and execution,
converting both synchronous exceptions and rejected promises to `DatabaseError`.
The query builder omits interactive transactions and direct client access. Reads
are scoped explicitly: `ProjectRepo.find(orgId, id)` and
`TrustPolicyRepo.find(projectId, id)`. Authorization stays in the owning domain.

`Database.batch(db => [statement, ...])` is the atomic mutation path. It accepts a
nonempty tuple of unexecuted Drizzle statements, returns typed results in order,
and maps any failure to `DatabaseError`. Build the domain mutation and audit insert
in the same callback. Standalone repository writes are persistence primitives;
admin use cases must batch their writes with audit records.

```ts
const result =
  yield *
  database.batch((db) => [
    db.insert(schema.project).values(project).returning(),
    db.insert(schema.auditEvent).values(event).returning(),
  ]);
```

## Schemas and migrations

All tables live in `src/schema`. The initial migration includes generated Better
Auth core tables, projects, project grants, trust policies, instance settings,
audit events/outbox and rollups. Times in domain tables are epoch milliseconds;
Better Auth uses its generated Date mapping. Business validation, auth plugin
configuration, audit event validation/hash chains and rollup aggregation belong
to their owning follow-up issues. Auth plugin tables must be generated here when
STV-432 adds its runtime configuration; there is one migration pipeline.

From the root:

```sh
bun run db:generate
bun run db:check
```

Generate and commit SQL before deployment. `db:check` validates migration history,
rejects SQL outside the conservative additive allowlist (new tables/indexes and
added columns), and generates into a temporary copy to catch schema drift. The root
`bun run check` command runs it. Review added columns for safe defaults and compatibility with existing rows.
Never edit an applied migration; add another migration. STV-501 owns the broader
upgrade/rollback workflow and deployed schema guard.

The existing `@repo/infra` D1 resource points at `packages/db/migrations` and Alchemy
applies pending migrations during local development or an explicitly requested
deployment. It maintains `__alchemy_migrations`; don't mix manual migration runners.
Drizzle ORM and Kit are pinned to matching `1.0.0-rc.5` versions because Alchemy
`2.0.0-beta.83` rejects the stable 0.x journal layout. Deploy consumes committed SQL;
it does not generate schema changes.

`bun run --cwd packages/db db:auth:generate` regenerates Better Auth core tables.
The generation-only config has no runtime credentials. Better Auth 1.7 emits old
relation helpers, so the script removes those declarations; `DatabaseLive` builds
Drizzle 1.x relations from all tables. Re-run `db:generate` after auth changes.

## Tests

Import `DatabaseTest` or `D1ClientTest` from **`@repo/db/testing`** in Bun tests only.
This public test entry point keeps Bun and filesystem imports out of Worker bundles.
Each build acquires a fresh in-memory `bun:sqlite` database, applies the committed
migrations, enables foreign keys, and closes it with the layer scope. The private
D1-compatible test adapter supplies the query/batch surface used by Drizzle.

`bun run --cwd packages/db test` exercises repository behavior, isolation, typed
failures and mutation/outbox rollback against both SQLite and real local D1 through
Miniflare. The latter integration tests launch workerd, with no Cloudflare account,
credentials, network services or deployment. Domain tests can use `DatabaseTest`
alone without a Worker runtime. The same test cases against local D1 verify that
the SQLite test adapter's behavior agrees with production's atomic batch contract.
