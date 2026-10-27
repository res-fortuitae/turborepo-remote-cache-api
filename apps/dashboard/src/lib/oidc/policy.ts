type OidcPolicy = {
  /** OIDC discovery root. https only, no query or fragment. */
  issuer: string;
  claims: Record<string, string[]>;
  label?: string;
};

/** The gate for anything headed to storage; the verifier refuses failures. */
function validateOidcPolicy(policy: OidcPolicy) {
  const errors: { path: string; message: string }[] = [];

  if (!policy.issuer) {
    errors.push({ path: "issuer", message: "Issuer is required." });
  } else {
    let url: URL | null = null;
    try {
      url = new URL(policy.issuer);
    } catch {
      url = null;
    }
    if (!url) {
      errors.push({ path: "issuer", message: "Issuer must be a valid URL." });
    } else {
      if (url.protocol !== "https:") {
        errors.push({ path: "issuer", message: "Issuer must use https." });
      }
      if (url.search || url.hash) {
        errors.push({
          path: "issuer",
          message: "Issuer must not contain a query or fragment.",
        });
      }
    }
  }

  const claims = policy.claims ?? {};
  if (!Object.keys(claims).includes("aud")) {
    errors.push({
      path: "claims.aud",
      message: "An audience (aud) claim is required.",
    });
  }
  for (const [name, accepted] of Object.entries(claims)) {
    if (!name.trim()) {
      errors.push({ path: "claims", message: "Claim names cannot be empty." });
      continue;
    }
    // Prototype-chain names silently vanish from plain-object claim maps.
    if (["__proto__", "constructor", "prototype"].includes(name)) {
      errors.push({
        path: `claims.${name}`,
        message: `Claim name "${name}" is not allowed.`,
      });
      continue;
    }
    if (!Array.isArray(accepted) || accepted.length === 0) {
      errors.push({
        path: `claims.${name}`,
        message: `Claim "${name}" must accept at least one value.`,
      });
      continue;
    }
    if (accepted.some((value) => typeof value !== "string" || value === "")) {
      errors.push({
        path: `claims.${name}`,
        message: `Claim "${name}" has an empty or non-string accepted value.`,
      });
    }
  }

  return errors;
}

/** The matching source of truth. `claims` must be a verified payload. */
function explainOidcPolicy(policy: OidcPolicy, claims: Record<string, unknown>) {
  const checks: {
    claim: string;
    accepted: string[];
    actual: unknown;
    ok: boolean;
    reason?: "missing" | "mismatch" | "invalid-rule";
  }[] = [];

  checks.push({
    claim: "iss",
    accepted: [policy.issuer],
    actual: claims.iss,
    ok: claims.iss === policy.issuer,
    reason:
      claims.iss === policy.issuer ? undefined : claims.iss === undefined ? "missing" : "mismatch",
  });

  const rules = Object.entries(policy.claims ?? {});
  if (rules.length === 0) {
    checks.push({
      claim: "aud",
      accepted: [],
      actual: claims.aud,
      ok: false,
      reason: "invalid-rule",
    });
  }

  for (const [name, accepted] of rules) {
    if (!Array.isArray(accepted) || accepted.some((value) => typeof value !== "string")) {
      checks.push({
        claim: name,
        accepted: [],
        actual: claims[name],
        ok: false,
        reason: "invalid-rule",
      });
      continue;
    }
    const actual = claims[name];
    if (actual === undefined || actual === null) {
      checks.push({
        claim: name,
        accepted,
        actual,
        ok: false,
        reason: "missing",
      });
      continue;
    }
    const values = Array.isArray(actual) ? actual : [actual];
    const ok = values.some((value) => typeof value === "string" && accepted.includes(value));
    checks.push({
      claim: name,
      accepted,
      actual,
      ok,
      reason: ok ? undefined : "mismatch",
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function matchOidcPolicy(policy: OidcPolicy, claims: Record<string, unknown>) {
  return explainOidcPolicy(policy, claims).ok;
}

function matchOidcPolicies(policies: OidcPolicy[], claims: Record<string, unknown>) {
  return policies.find((policy) => matchOidcPolicy(policy, claims)) ?? null;
}

export { validateOidcPolicy, explainOidcPolicy, matchOidcPolicy, matchOidcPolicies };
export type { OidcPolicy };
