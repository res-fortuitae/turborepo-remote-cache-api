import { TrustPolicyBody } from "@repo/api-spec";
import type { TrustPolicy } from "@repo/db";
import { Context, Layer, Schema } from "effect";
import type { JWTPayload } from "jose";

export interface PolicyFailure {
  readonly policyId: string;
  readonly failedClaims: readonly string[];
}

export type TrustPolicyDecision =
  | {
      readonly matched: true;
      readonly policyIds: readonly string[];
      readonly scope: "read" | "read write";
      readonly ttlSeconds: number;
      readonly requireBoundTokens: boolean;
    }
  | { readonly matched: false; readonly closest: PolicyFailure | null };

const validBody = Schema.is(TrustPolicyBody);
const isString = Schema.is(Schema.String);

/** Only * and ? are special. Identity claims never pass through this matcher. */
const glob = (pattern: string, value: string): boolean => {
  let p = 0;
  let v = 0;
  let star = -1;
  let retry = 0;

  while (v < value.length) {
    if (pattern[p] === "?" || pattern[p] === value[v]) {
      p++;
      v++;
    } else if (pattern[p] === "*") {
      star = p++;
      retry = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++retry;
    } else return false;
  }

  while (pattern[p] === "*") p++;

  return p === pattern.length;
};

const matcher = {
  /** Claims must already have passed OidcVerifier signature and lifetime checks. */
  match: (
    project: {
      readonly id: string;
      readonly archivedAt: number | null;
      readonly deleted?: boolean;
    },
    policies: readonly TrustPolicy[],
    claims: JWTPayload,
  ): TrustPolicyDecision => {
    if (project.deleted) return { matched: false, closest: null };
    const matches: TrustPolicy[] = [];
    let closest: PolicyFailure | null = null;

    for (const policy of policies) {
      if (policy.projectId !== project.id || !policy.enabled) continue;
      const body = policy.body;
      const failedClaims: string[] = [];

      if (!validBody(body)) failedClaims.push("invalid-policy");
      else {
        if (body.issuer !== claims.iss) failedClaims.push("iss");

        for (const [claim, expected] of Object.entries(body.claims)) {
          const actual = Object.hasOwn(claims, claim) ? claims[claim] : undefined;
          const values = Array.isArray(actual) ? actual : [actual];

          if (!values.some((value) => isString(value) && expected.includes(value)))
            failedClaims.push(claim);
        }

        if (
          body.refPatterns !== undefined &&
          !body.refPatterns.some((pattern) =>
            [claims.ref, claims.branch].some((ref) => isString(ref) && glob(pattern, ref)),
          )
        )
          failedClaims.push("refPatterns");
      }

      if (failedClaims.length === 0) matches.push(policy);
      else if (closest === null || failedClaims.length < closest.failedClaims.length)
        closest = { policyId: policy.id, failedClaims };
    }

    if (matches.length === 0) return { matched: false, closest };

    return {
      matched: true,
      policyIds: matches.map((policy) => policy.id),
      scope:
        project.archivedAt !== null || matches.some((policy) => policy.body.scope === "read")
          ? "read"
          : "read write",
      ttlSeconds: Math.min(...matches.map((policy) => policy.body.ttlSeconds)),
      requireBoundTokens: matches.some((policy) => policy.body.requireBoundTokens === true),
    };
  },
};

export class TrustPolicyMatcher extends Context.Service<TrustPolicyMatcher, typeof matcher>()(
  "@repo/oidc/TrustPolicyMatcher",
) {}

export const TrustPolicyMatcherLive = Layer.succeed(TrustPolicyMatcher, matcher);
export const TrustPolicyMatcherTest = TrustPolicyMatcherLive;
