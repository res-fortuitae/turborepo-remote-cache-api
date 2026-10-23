import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { CacheScope, Id, Timestamp } from "./common.ts";
import { ApiErrors } from "./http-errors.ts";

export const ExchangeRequest = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
  team: Id,
  project: Id,
});

export const ExchangeHeaders = Schema.Struct({
  dpop: Schema.optional(Schema.RedactedFromValue(Schema.NonEmptyString)),
});

export const ExchangeResponse = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
  expiresAt: Timestamp,
  api: Schema.String,
  team: Id,
  project: Id,
  scope: CacheScope,
  signatureKey: Schema.optional(Schema.RedactedFromValue(Schema.NonEmptyString)),
});

export const OidcApi = HttpApiGroup.make("oidc").add(
  HttpApiEndpoint.post("exchange", "/oidc/exchange", {
    headers: ExchangeHeaders,
    payload: ExchangeRequest,
    success: ExchangeResponse,
    error: ApiErrors,
  }),
);

export type ExchangeRequest = typeof ExchangeRequest.Type;

export type ExchangeResponse = typeof ExchangeResponse.Type;
