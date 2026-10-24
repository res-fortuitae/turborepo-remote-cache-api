import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** An exact audience identifier, including opaque identifiers such as URNs. */
export const OidcAudiences = Schema.Array(Schema.NonEmptyString.check(Schema.isTrimmed())).check(
  Schema.isMinLength(1),
);

/** HTTPS in hosted stages; HTTP is permitted only for local development. */
export const Origin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        value === url.origin &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }),
);

export class CanonicalOrigin extends Context.Service<CanonicalOrigin, string>()(
  "@repo/deploy-config/CanonicalOrigin",
) {}

/** Accepted CI audiences; distinct from the audience on our issued cache JWTs. */
export class OidcAudience extends Context.Service<OidcAudience, readonly string[]>()(
  "@repo/deploy-config/OidcAudience",
) {}

const decodeOrigin = Schema.decodeUnknownSync(Origin);
const decodeAudiences = Schema.decodeUnknownSync(OidcAudiences);

export const resolveOriginSettings = (origin: string, audiences?: readonly string[]) => {
  const canonicalOrigin = decodeOrigin(origin);

  return {
    canonicalOrigin,
    oidcAudiences: [...new Set(decodeAudiences(audiences ?? [canonicalOrigin]))],
  };
};

/** Return the exact matched value for policy checks and exchange audit records. */
export const matchOidcAudience = (
  configured: readonly string[],
  presented: string | readonly string[],
) => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Both JWT audience representations have already been decoded by the verifier.
  const candidates = typeof presented === "string" ? [presented] : presented;

  return Option.fromNullishOr(configured.find((audience) => candidates.includes(audience)));
};
