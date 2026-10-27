import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { AnalyticsError } from "./emitter.ts";
import { BasinSqlClient } from "./rollups.ts";

export class BasinSqlConfig extends Context.Service<
  BasinSqlConfig,
  {
    readonly accountId: string;
    readonly bucket: string;
    readonly token: Redacted.Redacted<string>;
  }
>()("@repo/analytics/BasinSqlConfig") {}

const decode = Schema.decodeUnknownEffect(
  Schema.Struct({
    success: Schema.Literal(true),
    result: Schema.Struct({ rows: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(2001)) }),
  }),
);

/** Only domain-owned fixed templates call this adapter. Never expose raw query text through routes. */
export const BasinSqlClientLive = Layer.effect(
  BasinSqlClient,
  Effect.gen(function* () {
    const config = yield* BasinSqlConfig;
    const client = yield* HttpClient.HttpClient;

    return {
      query: (query) =>
        Effect.gen(function* () {
          if (
            !/^[a-f0-9]{32}$/.test(config.accountId) ||
            !/^[a-z0-9][a-z0-9-]{1,62}$/.test(config.bucket)
          )
            return yield* new AnalyticsError({
              cause: "Invalid analytics warehouse configuration",
            });

          const request = HttpClientRequest.post(
            `https://api.sql.cloudflarestorage.com/api/v1/accounts/${config.accountId}/basin-sql/query/${config.bucket}`,
          ).pipe(
            HttpClientRequest.bearerToken(config.token),
            HttpClientRequest.bodyJson({ query }),
          );

          const response = yield* client.execute(yield* request);

          if (response.status !== 200)
            return yield* new AnalyticsError({ cause: "Analytics warehouse unavailable" });
          const decoder = new TextDecoder();
          let size = 0;

          const text = yield* Stream.runFoldEffect(
            response.stream,
            () => "",
            (text, chunk) => {
              size += chunk.byteLength;

              return size > 8 * 1024 * 1024
                ? Effect.fail(new AnalyticsError({ cause: "Warehouse response exceeds limit" }))
                : Effect.succeed(text + decoder.decode(chunk, { stream: true }));
            },
          );

          const json = yield* Effect.try(() => JSON.parse(text + decoder.decode()));

          return (yield* decode(json)).result.rows;
        }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "omit",
          }),
          Effect.timeout("30 seconds"),
          Effect.mapError(
            () => new AnalyticsError({ cause: "Analytics warehouse unavailable or invalid" }),
          ),
        ),
    };
  }),
);
