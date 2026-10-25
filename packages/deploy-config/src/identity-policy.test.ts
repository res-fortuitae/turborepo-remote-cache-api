import { expect, test } from "bun:test";
import { defaultInstancePolicy, tightenPolicy } from "./identity-policy.ts";

test("org policy cannot weaken instance restrictions or turn a disjoint allowlist into unrestricted signup", () => {
  const parent = {
    ...defaultInstancePolicy,
    allowedEmailDomains: ["example.com"],
    apiKeys: "disallowed" as const,
    requireBoundTokens: true,
    requireArtifactSigning: true,
    maxTokenTtlSeconds: 100,
  };
  const child = tightenPolicy(parent, {
    ...defaultInstancePolicy,
    allowedEmailDomains: [],
    apiKeys: "allowed",
    maxTokenTtlSeconds: 9999,
  });
  expect(child.apiKeys).toBe("disallowed");
  expect(child.maxTokenTtlSeconds).toBe(100);
  expect(child.allowedEmailDomains).toEqual(["example.com"]);
  expect(child.requireBoundTokens).toBe(true);
  expect(child.requireArtifactSigning).toBe(true);
  expect(() =>
    tightenPolicy(parent, { ...defaultInstancePolicy, allowedEmailDomains: ["other.com"] }),
  ).toThrow();
});

test("OIDC workflow and environment restrictions survive org overrides", () => {
  const parent = {
    ...defaultInstancePolicy,
    oidcWriteWorkflowRefs: ["org/repo/.github/workflows/cache.yml@refs/heads/main"],
    oidcWriteEnvironments: ["protected"],
  };
  const effective = tightenPolicy(parent, {
    ...defaultInstancePolicy,
    oidcWriteWorkflowRefs: [],
    oidcWriteEnvironments: [],
  });
  expect(effective.oidcWriteWorkflowRefs).toEqual(parent.oidcWriteWorkflowRefs);
  expect(effective.oidcWriteEnvironments).toEqual(["protected"]);
  expect(() =>
    tightenPolicy(parent, { ...defaultInstancePolicy, oidcWriteEnvironments: ["unprotected"] }),
  ).toThrow();
});
