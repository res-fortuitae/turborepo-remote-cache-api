export const actions = [
  "create",
  "read",
  "update",
  "delete",
  "grant",
  "cache:read",
  "cache:write",
  "trustPolicy:create",
  "trustPolicy:update",
  "trustPolicy:delete",
  "apiKey:create",
  "apiKey:revoke",
  "audit:read",
  "audit:export",
  "analytics:read",
  "settings:update",
] as const;

export type Action = (typeof actions)[number];

export interface SessionPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

export interface CredentialPrincipal {
  readonly kind: "apiKey" | "cacheJwt";
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly scope: "read" | "read write";
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly signed?: boolean;
  readonly bound?: boolean;
}

export type Principal = SessionPrincipal | CredentialPrincipal;

export interface Resource {
  readonly orgId: string;
  readonly projectId?: string;
  readonly requestedPolicy?: {
    readonly maxTokenTtlSeconds?: number;
    readonly requireArtifactSigning?: boolean;
    readonly requireBoundTokens?: boolean;
  };
}

export interface Decision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface DecisionFacts {
  readonly active: boolean;
  readonly member: boolean;
  readonly instanceRole: string;
  readonly elevated: boolean;
  readonly orgPermission: boolean;
  readonly projectRole: "project:admin" | "cache:write" | "cache:read" | null;
  readonly exists: boolean;
  readonly archived: boolean;
  readonly orgArchived: boolean;
  readonly deleted?: boolean;
}

export interface Policy {
  readonly maxTokenTtlSeconds: number;
  readonly maxApiKeyLifetimeDays?: number;
  readonly requireArtifactSigning: boolean;
  readonly requireBoundTokens: boolean;
  readonly apiKeys: "allowed" | "warn" | "disallowed";
}

const deny = (reason: string): Decision => ({ allowed: false, reason });
const allow: Decision = { allowed: true, reason: "allowed" };

/** Pure, fail-closed policy core. Facts come from repositories, never HTTP input. */
export const decide = (
  principal: Principal,
  action: Action,
  resource: Resource,
  facts: DecisionFacts,
  policy: Policy,
  now: number,
): Decision => {
  if (!actions.includes(action)) return deny("unknown_action");

  if (!facts.exists || facts.deleted) return deny("resource_unavailable");

  if (action.startsWith("cache:") && !resource.projectId) return deny("project_required");

  const read = ["read", "cache:read", "audit:read", "audit:export", "analytics:read"].includes(
    action,
  );

  if (facts.orgArchived && !read) return deny("organization_archived");

  if (facts.archived && action === "cache:write") return deny("project_archived");
  const requested = resource.requestedPolicy;

  if (
    requested &&
    ((requested.maxTokenTtlSeconds !== undefined &&
      (!Number.isSafeInteger(requested.maxTokenTtlSeconds) ||
        requested.maxTokenTtlSeconds <= 0 ||
        requested.maxTokenTtlSeconds > policy.maxTokenTtlSeconds)) ||
      (policy.requireArtifactSigning && requested.requireArtifactSigning === false) ||
      (policy.requireBoundTokens && requested.requireBoundTokens === false))
  )
    return deny("instance_policy");

  if ("kind" in principal) {
    if (principal.orgId !== resource.orgId || principal.projectId !== resource.projectId)
      return deny("credential_tenant");

    const lifetime =
      principal.kind === "apiKey"
        ? (policy.maxApiKeyLifetimeDays ?? 30) * 86400
        : policy.maxTokenTtlSeconds;

    if (
      !Number.isSafeInteger(principal.issuedAt) ||
      !Number.isSafeInteger(principal.expiresAt) ||
      principal.issuedAt > now ||
      principal.expiresAt <= now ||
      principal.expiresAt <= principal.issuedAt ||
      principal.expiresAt - principal.issuedAt > lifetime
    )
      return deny("credential_lifetime");

    if (principal.kind === "apiKey" && policy.apiKeys === "disallowed")
      return deny("api_keys_disabled");

    if (policy.requireBoundTokens && !principal.bound) return deny("binding_required");

    if (action === "cache:write" && policy.requireArtifactSigning && !principal.signed)
      return deny("signing_required");

    if (action === "cache:read" && (principal.scope === "read" || principal.scope === "read write"))
      return allow;

    if (action === "cache:write" && principal.scope === "read write") return allow;

    return deny("credential_scope");
  }

  if (!facts.active) return deny("session_unavailable");

  if (facts.elevated && ["owner", "admin"].includes(facts.instanceRole)) return allow;

  if (!facts.member) return deny("organization_membership");

  if (facts.orgPermission) return allow;

  if (!resource.projectId) return deny("organization_permission");

  if (
    facts.projectRole === "project:admin" &&
    [
      "read",
      "update",
      "delete",
      "grant",
      "cache:read",
      "cache:write",
      "trustPolicy:create",
      "trustPolicy:update",
      "trustPolicy:delete",
      "apiKey:create",
      "apiKey:revoke",
    ].includes(action)
  )
    return allow;

  if (facts.projectRole !== null && ["read", "cache:read"].includes(action)) return allow;

  if (facts.projectRole === "cache:write" && action === "cache:write") return allow;

  return deny("project_permission");
};
