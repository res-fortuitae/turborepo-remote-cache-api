import * as NodeFSP from "node:fs/promises";
import { Database as SQLite } from "bun:sqlite";
import { sqliteTestClient } from "./sqlite-test-client.ts";
import { Effect, Layer } from "effect";
import { D1Client, DatabaseError, DatabaseLive } from "./database.ts";

/** In-memory SQLite with D1-compatible query execution, fresh for each layer build. Import only in Bun/Node test entry points. */
export const D1ClientTest = Layer.effect(
  D1Client,
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new SQLite(":memory:")),
      (runtime) => Effect.sync(() => runtime.close()),
    );

    return yield* Effect.tryPromise({
      try: async () => {
        runtime.exec("PRAGMA foreign_keys = ON");
        const client = sqliteTestClient(runtime);
        const directory = new URL("../migrations/", import.meta.url);

        for (const entry of (await NodeFSP.readdir(directory)).sort()) {
          if (!/^\d+_/.test(entry)) continue;
          const sql = await NodeFSP.readFile(new URL(`${entry}/migration.sql`, directory), "utf8");

          const statements = sql
            .split("--> statement-breakpoint")
            .map((sql) => sql.trim())
            .filter(Boolean);

          await client.batch(statements.map((statement) => client.prepare(statement)));
        }

        return client;
      },
      catch: (cause) => new DatabaseError({ operation: "DatabaseTest.migrate", cause }),
    });
  }),
);

export const DatabaseTest = DatabaseLive.pipe(Layer.provide(D1ClientTest));
