import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { CacheScope, Id, Timestamp } from "./common.ts";
import { ApiErrors } from "./http-errors.ts";

export const ExchangeRequest = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.NonEmptyString.check(Schema.isMaxLength(16_384))),
  team: Id.check(Schema.isMaxLength(256)),
  project: Id.check(Schema.isMaxLength(256)),
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
  previousSignatureKeys: Schema.optional(
    Schema.Array(Schema.RedactedFromValue(Schema.NonEmptyString)).check(Schema.isMaxLength(1)),
  ),
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

export const DeveloperTokenRequest = Schema.Struct({
  team: Id.check(Schema.isMaxLength(256)),
  project: Id.check(Schema.isMaxLength(256)),
  write: Schema.optional(Schema.Boolean),
  ttlSeconds: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(43200)),
  ),
});
export const DeveloperTokenApi = HttpApiGroup.make("developerTokens").add(
  HttpApiEndpoint.post("issue", "/tokens/dev", {
    payload: DeveloperTokenRequest,
    success: ExchangeResponse,
    error: ApiErrors,
  }),
);
