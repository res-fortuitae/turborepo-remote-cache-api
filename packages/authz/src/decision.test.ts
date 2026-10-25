import { expect, test } from "bun:test";
import { decide, type CredentialPrincipal, type DecisionFacts, type Policy } from "./decision.ts";

const facts: DecisionFacts = {
  active: true,
  member: true,
  instanceRole: "member",
  elevated: false,
  orgPermission: false,
  projectRole: "cache:write",
  exists: true,
  archived: false,
  orgArchived: false,
};

const policy: Policy = {
  maxTokenTtlSeconds: 900,
  requireArtifactSigning: false,
  requireBoundTokens: false,
  apiKeys: "allowed",
};

const resource = { orgId: "org", projectId: "project" };

const credential: CredentialPrincipal = {
  kind: "cacheJwt",
  id: "token",
  ...resource,
  scope: "read write",
  issuedAt: 100,
  expiresAt: 900,
};

test("pure decisions enforce tenant, scope, lifetime and instance clamps before role grants", () => {
  expect(decide(credential, "cache:write", resource, facts, policy, 200).allowed).toBe(true);
  expect(
    decide(credential, "cache:read", { ...resource, orgId: "other" }, facts, policy, 200).reason,
  ).toBe("credential_tenant");
  expect(
    decide(credential, "cache:read", { ...resource, projectId: "other" }, facts, policy, 200)
      .allowed,
  ).toBe(false);
  expect(
    decide({ ...credential, scope: "read" }, "cache:write", resource, facts, policy, 200).allowed,
  ).toBe(false);
  expect(decide(credential, "grant", resource, facts, policy, 200).allowed).toBe(false);
  expect(
    decide({ ...credential, expiresAt: 1200 }, "cache:read", resource, facts, policy, 200).reason,
  ).toBe("credential_lifetime");
  expect(
    decide(credential, "cache:write", resource, { ...facts, archived: true }, policy, 200).reason,
  ).toBe("project_archived");
  expect(
    decide(credential, "cache:read", resource, { ...facts, archived: true }, policy, 200).allowed,
  ).toBe(true);
  expect(
    decide(
      credential,
      "cache:write",
      resource,
      facts,
      { ...policy, requireArtifactSigning: true },
      200,
    ).reason,
  ).toBe("signing_required");
  expect(
    decide(credential, "cache:read", resource, facts, { ...policy, requireBoundTokens: true }, 200)
      .reason,
  ).toBe("binding_required");
  expect(
    decide(
      { ...credential, kind: "apiKey" },
      "cache:read",
      resource,
      facts,
      { ...policy, apiKeys: "disallowed" },
      200,
    ).reason,
  ).toBe("api_keys_disabled");
  expect(
    decide(
      { userId: "admin", sessionId: "session" },
      "update",
      { ...resource, requestedPolicy: { maxTokenTtlSeconds: 901 } },
      { ...facts, instanceRole: "admin", elevated: true },
      policy,
      200,
    ).reason,
  ).toBe("instance_policy");
});
