/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Exercises the HTTP adapter boundary. */
import { expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { BasinSqlClient } from "./rollups.ts";
import { BasinSqlClientLive, BasinSqlConfig } from "./sql-client.ts";

const config = Layer.succeed(BasinSqlConfig, {
  accountId: "a".repeat(32),
  bucket: "analytics-catalog",
  token: Redacted.make("private-reader-token"),
});

test("warehouse adapter uses the fixed endpoint and bounds and sanitizes failures", async () => {
  for (const kind of ["ok", "failure", "oversized", "invalid"] as const) {
    const client = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.url).toBe(
            `https://api.sql.cloudflarestorage.com/api/v1/accounts/${"a".repeat(32)}/basin-sql/query/analytics-catalog`,
          );
          expect(request.method).toBe("POST");
          expect(request.headers.authorization).toBe("Bearer private-reader-token");

          const response =
            kind === "failure"
              ? new Response("private-reader-token", { status: 503 })
              : kind === "oversized"
                ? new Response("x".repeat(8 * 1024 * 1024 + 1))
                : Response.json(
                    kind === "ok"
                      ? { success: true, result: { rows: [{ value: 1 }] } }
                      : { success: true, result: {} },
                  );

          return HttpClientResponse.fromWeb(request, response);
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(BasinSqlClient, (sql) => sql.query("SELECT internal_template")).pipe(
        Effect.result,
        Effect.provide(BasinSqlClientLive.pipe(Layer.provide(Layer.mergeAll(config, client)))),
      ),
    );

    expect(result._tag).toBe(kind === "ok" ? "Success" : "Failure");
    expect(JSON.stringify(result)).not.toContain("private-reader-token");
  }
});
