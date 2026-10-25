import { TrustPolicyRequest, type PolicyFinding, type PolicyGuardrailReport } from "@repo/api-spec";
import type { TrustPolicy } from "@repo/db";
import { Context, Layer, Schema } from "effect";
import type { JWTPayload } from "jose";
import { matcher } from "./trust-policy-matcher.ts";

type Finding = typeof PolicyFinding.Type;
export interface PolicyGuardrailSettings {
  readonly audiences: readonly string[];
  readonly maxTokenTtlSeconds: number;
  readonly allowedIssuers: readonly string[];
  readonly requireBoundTokens?: boolean;
  readonly workflowRefs?: readonly string[];
  readonly environments?: readonly string[];
}

const valid = Schema.is(TrustPolicyRequest);
const immutableClaims: Readonly<Record<string, readonly string[]>> = {
  github: ["repository_id", "repository_owner_id"],
  vercel: ["owner_id", "project_id"],
  gitlab: ["project_id", "namespace_id"],
};

const evaluate = (
  policy: typeof TrustPolicyRequest.Type,
  settings: PolicyGuardrailSettings,
): typeof PolicyGuardrailReport.Type => {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const error = (code: string, message: string, claim?: string) =>
    errors.push({ code, message, claim });
  const warn = (code: string, message: string, claim?: string) =>
    warnings.push({ code, message, claim });
  if (!valid(policy)) {
    error("invalid_policy", "Policy does not satisfy the trust policy contract");
    return { errors, warnings };
  }
  const claims = policy.claims;
  const ids = immutableClaims[policy.provider];
  if (!ids)
    error(
      "unsupported_provider",
      "This provider needs an immutable identity profile before policies can be saved",
    );
  for (const claim of ids ?? []) {
    if (!Object.hasOwn(claims, claim) || !claims[claim]?.length)
      error("immutable_identity_required", "An immutable identity rule is required", claim);
    else if (
      (policy.provider === "github" || policy.provider === "gitlab") &&
      !claims[claim]?.every((value) => /^[0-9]+$/.test(value))
    )
      error("invalid_immutable_identity", "Identity IDs must be numeric", claim);
  }
  if (!settings.allowedIssuers.includes(policy.issuer))
    error("issuer_disallowed", "Issuer is not allowed by effective instance policy", "iss");
  if (
    policy.provider === "github" &&
    !/^https:\/\/token\.actions\.githubusercontent\.com(?:\/[a-z0-9-]+)?$/.test(policy.issuer)
  )
    error("provider_issuer_mismatch", "GitHub policies must use a GitHub Actions issuer", "iss");
  if (
    policy.provider === "vercel" &&
    !/^https:\/\/oidc\.vercel\.com(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/.test(policy.issuer)
  )
    error("provider_issuer_mismatch", "Vercel policies must use a Vercel issuer", "iss");
  if (/[?*]/.test(policy.issuer))
    error("wildcard_forbidden", "Issuer patterns are forbidden", "iss");
  for (const [claim, values] of Object.entries(claims)) {
    if (values.some((value) => /[?*]/.test(value)))
      error("wildcard_forbidden", "Claim patterns belong only in refPatterns", claim);
  }
  if (!claims.aud?.every((value) => settings.audiences.includes(value)))
    error("audience_mismatch", "Every audience must be a configured API audience", "aud");
  if (policy.ttlSeconds > settings.maxTokenTtlSeconds)
    error("ttl_exceeds_maximum", "TTL exceeds the effective token ceiling");
  else if (policy.ttlSeconds >= settings.maxTokenTtlSeconds * 0.8)
    warn("ttl_near_maximum", "TTL is at least 80% of the effective maximum");
  if (settings.requireBoundTokens && !policy.requireBoundTokens)
    error("bound_tokens_required", "Effective policy requires bound tokens");
  if (policy.scope === "read write") {
    const safeGithub =
      policy.provider !== "github" ||
      ((claims.event_name?.length ?? 0) > 0 &&
        claims.event_name?.every((event) =>
          ["push", "workflow_dispatch", "schedule"].includes(event),
        ) &&
        !claims.sub?.some((value) => value.endsWith(":pull_request")) &&
        !claims.fork?.some((value) => value === "true"));
    const safeVercel =
      policy.provider !== "vercel" ||
      (claims.environment?.length === 1 && claims.environment[0] === "production");
    const safeGitlab =
      policy.provider !== "gitlab" ||
      ((claims.pipeline_source?.length ?? 0) > 0 &&
        claims.pipeline_source?.every((value) => ["push", "web", "schedule"].includes(value)));
    if (!safeGithub || !safeVercel || !safeGitlab) {
      if (policy.allowUntrustedWrites)
        warn(
          "untrusted_writes_enabled",
          "Explicit override allows writes from pull requests, forks or preview jobs",
        );
      else
        error(
          "untrusted_writes_forbidden",
          "Write policies must constrain trusted events or production; explicitly acknowledge untrusted writes to override",
        );
    } else if (policy.allowUntrustedWrites)
      warn("untrusted_writes_enabled", "Untrusted write override is enabled");
    if (policy.refPatterns?.some((pattern) => /[?*]/.test(pattern)))
      warn("broad_write_refs", "Write access uses a broad ref pattern", "refPatterns");
    if (!claims.job_workflow_ref?.length && !claims.environment?.length)
      warn("unrestricted_write_job", "Restrict writes to a workflow file or protected environment");
    for (const [claim, allowed] of [
      ["job_workflow_ref", settings.workflowRefs],
      ["environment", settings.environments],
    ] as const) {
      if (
        allowed?.length &&
        (!claims[claim]?.length || !claims[claim]?.every((value) => allowed.includes(value)))
      )
        error(
          "write_restriction_required",
          "Write policy must restrict this claim to the configured allowlist",
          claim,
        );
    }
  }
  return { errors, warnings };
};

const service = {
  evaluate,
  /** Simulation only: this never verifies tokens, consumes replay IDs or grants credentials. */
  test: (
    project: Parameters<typeof matcher.match>[0],
    policies: readonly TrustPolicy[],
    claims: JWTPayload,
    settings: PolicyGuardrailSettings,
  ) => {
    const reports = policies
      .filter((policy) => policy.projectId === project.id)
      .map((policy) => {
        const report = evaluate(
          { ...policy.body, provider: policy.provider, enabled: policy.enabled },
          settings,
        );
        const decision = matcher.match(project, [{ ...policy, enabled: true }], claims);
        const failedClaims = decision.matched
          ? []
          : (decision.closest?.failedClaims ?? ["project"]);
        const keys = valid({ ...policy.body, provider: policy.provider, enabled: policy.enabled })
          ? [
              "iss",
              ...Object.keys(policy.body.claims),
              ...(policy.body.refPatterns === undefined ? [] : ["refPatterns"]),
            ]
          : ["invalid-policy"];
        return {
          policyId: policy.id,
          enabled: policy.enabled,
          ...report,
          failedClaims,
          checks: [...new Set([...keys, ...failedClaims])].map((claim) => ({
            claim,
            matched: !failedClaims.includes(claim),
            message: failedClaims.includes(claim)
              ? "Rule did not match sample claims"
              : "Rule matched sample claims",
          })),
        };
      });
    const safe = policies.filter((policy) =>
      reports.some((report) => report.policyId === policy.id && report.errors.length === 0),
    );
    const decision = matcher.match(project, safe, claims);
    return {
      simulation: true as const,
      matched: decision.matched,
      policyIds: decision.matched ? decision.policyIds : [],
      ...(decision.matched
        ? {
            scope: decision.scope,
            ttlSeconds: decision.ttlSeconds,
            requireBoundTokens: decision.requireBoundTokens,
          }
        : {}),
      policies: reports,
    };
  },
};

export class PolicyGuardrails extends Context.Service<PolicyGuardrails, typeof service>()(
  "@repo/oidc/PolicyGuardrails",
) {}
export const PolicyGuardrailsLive = Layer.succeed(PolicyGuardrails, service);
export const PolicyGuardrailsTest = PolicyGuardrailsLive;
