import type { D1Database } from "@cloudflare/workers-types";
import * as NodeFSP from "node:fs/promises";
import { Miniflare } from "miniflare";
import { Effect, Layer } from "effect";
import { D1Client, DatabaseError, DatabaseLive } from "./database.ts";

/** Real local D1, fresh for each layer build. Import only in Bun/Node test entry points. */
export const D1ClientLocalTest = Layer.effect(
  D1Client,
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare({
            modules: true,
            script: "export default { fetch() { return new Response('test'); } }",
            compatibilityDate: "2026-07-30",
            d1Databases: { Database: "test-database" },
          }),
      ),
      (runtime) => Effect.promise(() => runtime.dispose()),
    );

    return yield* Effect.tryPromise({
      try: async () => {
        const client = await runtime.getD1Database("Database");
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

        // SAFETY: Miniflare implements the D1 binding API; only cross-package nominal types differ.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The SDKs differ in nominal RPC branding, not in their D1 API.
        return client as unknown as D1Database;
      },
      catch: (cause) => new DatabaseError({ operation: "DatabaseTest.migrate", cause }),
    });
  }),
);

export const DatabaseLocalTest = DatabaseLive.pipe(Layer.provide(D1ClientLocalTest));
