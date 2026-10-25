import * as Schema from "effect/Schema";

/** Custom identities never trigger discovery: operators pin public RSA keys. */
export const PublicOidcIssuer = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !url.port &&
        url.href.replace(/\/$/, "") === value.replace(/\/$/, "") &&
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) &&
        !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)
      );
    } catch {
      return false;
    }
  }),
);

const PublicRsaKey = Schema.StructWithRest(
  Schema.Struct({
    kty: Schema.Literal("RSA"),
    alg: Schema.Literal("RS256"),
    kid: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    n: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.isMaxLength(2048)),
    e: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.isMaxLength(16)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
).check(
  Schema.makeFilter(
    (key) =>
      !["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((name) => Object.hasOwn(key, name)),
  ),
);

export const CustomOidcIssuers = Schema.Array(
  Schema.Struct({
    issuer: PublicOidcIssuer,
    /** Custom subjects must be stable, issuer-owned identities; add other exact policy conditions. */
    keys: Schema.Array(PublicRsaKey).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(10),
      Schema.makeFilter((keys) => new Set(keys.map((key) => key.kid)).size === keys.length),
    ),
  }),
).check(
  Schema.isMaxLength(20),
  Schema.makeFilter(
    (entries) => new Set(entries.map((entry) => entry.issuer)).size === entries.length,
  ),
);
