import type { D1Database } from "@cloudflare/workers-types";
import { defineRelations } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { Context, Effect, Layer, Schema } from "effect";
import * as schema from "./schema/index.ts";

export class D1Client extends Context.Service<D1Client, D1Database>()("@repo/db/D1Client") {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

/** Query construction stays lazy so synchronous SDK errors enter the error channel too. */
const relations = defineRelations(schema);

export type DatabaseQueries = Pick<
  DrizzleD1Database<typeof relations>,
  | "select"
  | "selectDistinct"
  | "insert"
  | "update"
  | "delete"
  | "query"
  | "run"
  | "all"
  | "get"
  | "values"
>;

export type DatabaseStatement = BatchItem<"sqlite">;

export type DatabaseBatch = readonly [DatabaseStatement, ...DatabaseStatement[]];

export type DatabaseDrizzle = DrizzleD1Database<typeof relations>;

export interface DatabaseService {
  /**
   * The Drizzle handle for library adapters that manage their own queries
   * (Better Auth's `drizzleAdapter`). Domain code uses `query` and `batch`.
   */
  readonly drizzle: DatabaseDrizzle;
  readonly query: <A>(
    operation: string,
    query: (db: DatabaseQueries) => PromiseLike<A>,
  ) => Effect.Effect<A, DatabaseError>;
  readonly batch: <T extends DatabaseBatch>(
    statements: (db: DatabaseQueries) => T,
  ) => Effect.Effect<BatchResponse<T>, DatabaseError>;
}

export class Database extends Context.Service<Database, DatabaseService>()("@repo/db/Database") {}

export const DatabaseLive: Layer.Layer<Database, never, D1Client> = Layer.effect(
  Database,
  Effect.gen(function* () {
    const client = yield* D1Client;
    const db = drizzle(client, { relations });

    return {
      drizzle: db,
      query: (operation, query) =>
        Effect.tryPromise({
          try: async () => await query(db),
          catch: (cause) => new DatabaseError({ operation, cause }),
        }),
      batch: (statements) =>
        Effect.tryPromise({
          try: () => db.batch(statements(db)),
          catch: (cause) => new DatabaseError({ operation: "Database.batch", cause }),
        }),
    } satisfies DatabaseService;
  }),
);
