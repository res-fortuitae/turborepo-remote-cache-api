import type * as Redacted from "effect/Redacted";

/** Existing single-tenant bearer token, kept redacted outside authentication. */
export type TurboToken = Redacted.Redacted<string>;
