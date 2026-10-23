import * as Schema from "effect/Schema";

/** `read` for restore-only clients, `read write` for clients that also upload. */
export const CacheScope = Schema.Literals(["read", "read write"]);

export type CacheScope = typeof CacheScope.Type;

/**
 * Who a verified cache token speaks for. The tenant (`org`, `project`) comes
 * from the signed claims, never from the request, so authz and artifacts can
 * trust it as is.
 */
export const Principal = Schema.Struct({
  /** `oidc:github:repo:<id>:ref:...` or `user:<id>`. */
  subject: Schema.NonEmptyString,
  org: Schema.NonEmptyString,
  project: Schema.NonEmptyString,
  scope: CacheScope,
  tokenId: Schema.NonEmptyString,
  /** Seconds since the epoch, like the JWT claims they come from. */
  issuedAt: Schema.Int,
  expiresAt: Schema.Int,
});

export type Principal = typeof Principal.Type;
