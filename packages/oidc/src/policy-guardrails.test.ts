/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary for pure service behavior. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { TrustPolicy } from "@repo/db";
import type { TrustPolicyRequest } from "@repo/api-spec";
import {
  PolicyGuardrails,
  PolicyGuardrailsTest,
  TrustPolicyMatcher,
  TrustPolicyMatcherTest,
  type PolicyGuardrailSettings,
} from "./index.ts";

const settings: PolicyGuardrailSettings = {
  audiences: ["cache", "old-cache"],
  maxTokenTtlSeconds: 900,
  allowedIssuers: [
    "https://token.actions.githubusercontent.com",
    "https://oidc.vercel.com/team",
    "https://gitlab.com",
  ],
};

const policy: typeof TrustPolicyRequest.Type = {
  provider: "github",
  enabled: true,
  issuer: "https://token.actions.githubusercontent.com",
  claims: {
    aud: ["cache"],
    repository_id: ["1"],
    repository_owner_id: ["2"],
    event_name: ["push"],
    ref: ["refs/heads/main"],
  },
  scope: "read write",
  ttlSeconds: 600,
};

const row: TrustPolicy = {
  id: "policy",
  projectId: "project",
  provider: "github",
  enabled: true,
  createdAt: 0,
  createdBy: "u",
  body: {
    ...policy,
    refPatterns: policy.refPatterns === undefined ? undefined : [...policy.refPatterns],
    claims: Object.fromEntries(
      Object.entries(policy.claims).map(([key, values]) => [key, [...values]]),
    ),
  },
};

const project = { id: "project", archivedAt: null };

const run = (task: (guardrails: typeof PolicyGuardrails.Service) => void) =>
  Effect.runPromise(
    Effect.gen(function* () {
      task(yield* PolicyGuardrails);
    }).pipe(Effect.provide(PolicyGuardrailsTest)),
  );

const codes = (findings: readonly { readonly code: string }[]) =>
  findings.map((finding) => finding.code);

test("requires immutable IDs, exact identity rules, allowed issuer and every configured audience", () =>
  run((guard) => {
    expect(guard.evaluate(policy, settings).errors).toEqual([]);

    const invalidClaims: (typeof TrustPolicyRequest.Type)["claims"][] = [
      { aud: ["cache"], repository: ["org/repo"] },
      { ...policy.claims, repository_id: ["name"] },
      { ...policy.claims, repository_owner_id: ["*"] },
      { ...policy.claims, repository: ["org/*"] },
      { ...policy.claims, aud: ["cache", "attacker"] },
      { ...policy.claims, aud: [] },
    ];

    for (const claims of invalidClaims)
      expect(guard.evaluate({ ...policy, claims }, settings).errors.length).toBeGreaterThan(0);
    expect(
      codes(guard.evaluate({ ...policy, issuer: "https://attacker.example" }, settings).errors),
    ).toContain("issuer_disallowed");
    expect(codes(guard.evaluate({ ...policy, provider: "custom" }, settings).errors)).toContain(
      "immutable_identity_required",
    );
  }));

test("refuses PR, target PR, unspecified event and preview writes unless explicitly acknowledged", () =>
  run((guard) => {
    for (const event of ["pull_request", "pull_request_target", "workflow_run"]) {
      const input = { ...policy, claims: { ...policy.claims, event_name: [event] } };
      expect(codes(guard.evaluate(input, settings).errors)).toContain("untrusted_writes_forbidden");
      const override = guard.evaluate({ ...input, allowUntrustedWrites: true }, settings);
      expect(override.errors).toEqual([]);
      expect(codes(override.warnings)).toContain("untrusted_writes_enabled");
      expect(guard.evaluate({ ...input, scope: "read" }, settings).errors).toEqual([]);
    }

    expect(
      codes(
        guard.evaluate(
          {
            ...policy,
            claims: { aud: ["cache"], repository_id: ["1"], repository_owner_id: ["2"] },
          },
          settings,
        ).errors,
      ),
    ).toContain("untrusted_writes_forbidden");

    const vercel = {
      ...policy,
      provider: "vercel" as const,
      issuer: "https://oidc.vercel.com/team",
      claims: {
        aud: ["cache"],
        owner_id: ["team_1"],
        project_id: ["prj_1"],
        environment: ["preview"],
      },
    };

    expect(codes(guard.evaluate(vercel, settings).errors)).toContain("untrusted_writes_forbidden");
    expect(guard.evaluate({ ...vercel, scope: "read" }, settings).errors).toEqual([]);
    expect(
      guard.evaluate(
        { ...vercel, claims: { ...vercel.claims, environment: ["production"] } },
        settings,
      ).errors,
    ).toEqual([]);

    const gitlab = {
      ...policy,
      provider: "gitlab" as const,
      issuer: "https://gitlab.com",
      claims: {
        aud: ["cache"],
        project_id: ["1"],
        namespace_id: ["2"],
        pipeline_source: ["merge_request_event"],
      },
    };

    expect(codes(guard.evaluate(gitlab, settings).errors)).toContain("untrusted_writes_forbidden");
  }));

test("warns on broad refs, unrestricted jobs and near maximum TTL; strict allowlists cannot be bypassed", () =>
  run((guard) => {
    const input = { ...policy, ttlSeconds: 800, refPatterns: ["refs/heads/*"] };
    expect(codes(guard.evaluate(input, settings).warnings)).toEqual([
      "ttl_near_maximum",
      "broad_write_refs",
      "unrestricted_write_job",
    ]);

    const strict = {
      ...settings,
      workflowRefs: ["org/repo/.github/workflows/cache.yml@refs/heads/main"],
      environments: ["protected"],
      requireBoundTokens: true,
    };

    expect(codes(guard.evaluate(input, strict).errors)).toEqual([
      "bound_tokens_required",
      "write_restriction_required",
      "write_restriction_required",
    ]);

    const constrained = {
      ...input,
      requireBoundTokens: true,
      claims: {
        ...input.claims,
        job_workflow_ref: [...strict.workflowRefs],
        environment: ["protected"],
      },
    };

    expect(guard.evaluate(constrained, strict).errors).toEqual([]);
    expect(
      codes(
        guard.evaluate(
          {
            ...constrained,
            claims: { ...constrained.claims, environment: ["protected", "unprotected"] },
          },
          strict,
        ).errors,
      ),
    ).toContain("write_restriction_required");
    expect(codes(guard.evaluate({ ...policy, ttlSeconds: 901 }, settings).errors)).toContain(
      "ttl_exceeds_maximum",
    );
  }));

test("tester excludes invalid and disabled policies, reports each policy and simulates archived read-only decisions", () =>
  run((guard) => {
    const claims = {
      iss: policy.issuer,
      aud: "cache",
      repository_id: "1",
      repository_owner_id: "2",
      event_name: "push",
      ref: "refs/heads/main",
    };

    const bad = { ...row, id: "legacy", body: { ...row.body, claims: { aud: ["cache"] } } };
    const disabled = { ...row, id: "disabled", enabled: false };
    const result = guard.test(project, [row, bad, disabled], claims, settings);
    expect(result).toMatchObject({
      simulation: true,
      matched: true,
      policyIds: ["policy"],
      scope: "read write",
    });
    expect(result.policies[1]?.errors.length).toBeGreaterThan(0);
    expect(
      guard.test(project, [row], { ...claims, repository_id: "other" }, settings),
    ).toMatchObject({ matched: false, policies: [{ failedClaims: ["repository_id"] }] });
    expect(guard.test({ ...project, archivedAt: 1 }, [row], claims, settings)).toMatchObject({
      matched: true,
      scope: "read",
    });
    expect(guard.test({ ...project, deleted: true }, [row], claims, settings).matched).toBe(false);
    expect(
      guard.test(project, [row], claims, { ...settings, requireBoundTokens: true }).matched,
    ).toBe(false);
  }));

test("matcher caps old broad write policies for fork and preview claims without an explicit override", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const matcher = yield* TrustPolicyMatcher;
      const broad = { ...row, body: { ...row.body, claims: { aud: ["cache"] } } };

      for (const extra of [
        { event_name: "pull_request_target" },
        { event_name: "pull_request" },
        { fork: true },
        { environment: "preview" },
        { sub: "repo:org/repo:pull_request" },
      ]) {
        const claims = { iss: policy.issuer, aud: "cache", ...extra };
        expect(matcher.match(project, [broad], claims)).toMatchObject({
          matched: true,
          scope: "read",
        });
        expect(
          matcher.match(
            project,
            [{ ...broad, body: { ...broad.body, allowUntrustedWrites: true } }],
            claims,
          ),
        ).toMatchObject({ matched: true, scope: "read write" });
      }
    }).pipe(Effect.provide(TrustPolicyMatcherTest)),
  ));

test("additional issuers bind immutable IDs and provider identity before allowing policies", () =>
  run((guard) => {
    const uuid = "11111111-1111-4111-8111-111111111111";

    const entries = [
      {
        provider: "gitlab",
        issuer: "https://gitlab.com",
        claims: { project_id: ["1"], namespace_id: ["2"] },
      },
      {
        provider: "circleci",
        issuer: `https://oidc.circleci.com/org/${uuid}`,
        claims: { "oidc.circleci.com/project-id": [uuid] },
      },
      {
        provider: "buildkite",
        issuer: "https://agent.buildkite.com",
        claims: { organization_id: [uuid], pipeline_id: [uuid] },
      },
      {
        provider: "bitbucket",
        issuer: "https://api.bitbucket.org/2.0/workspaces/acme/pipelines-config/identity/oidc",
        claims: { workspaceUuid: [`{${uuid}}`], repositoryUuid: [`{${uuid}}`] },
      },
      {
        provider: "aws-eks",
        issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/0123456789ABCDEF0123456789ABCDEF",
        claims: { sub: ["system:serviceaccount:ci:builder"] },
      },
      { provider: "google", issuer: "https://accounts.google.com", claims: { sub: ["123456789"] } },
      {
        provider: "azure",
        issuer: `https://login.microsoftonline.com/${uuid}/v2.0`,
        claims: { tid: [uuid], oid: [uuid] },
      },
      {
        provider: "azure",
        issuer: `https://eastus.oic.prod-aks.azure.com/${uuid}/${uuid}/`,
        claims: { sub: ["system:serviceaccount:ci:builder"] },
      },
      {
        provider: "custom",
        issuer: "https://identity.acme.com",
        claims: { sub: ["immutable-workload-id"] },
      },
    ] as const;

    for (const entry of entries) {
      const input = {
        ...policy,
        ...entry,
        scope: "read" as const,
        claims: { aud: ["cache"], ...entry.claims },
      };
      const config = { ...settings, allowedIssuers: [entry.issuer] };
      expect(guard.evaluate(input, config).errors).toEqual([]);
      expect(
        codes(guard.evaluate({ ...input, claims: { aud: ["cache"] } }, config).errors),
      ).toContain("immutable_identity_required");
      expect(codes(guard.evaluate(input, { ...config, allowedIssuers: [] }).errors)).toContain(
        "issuer_disallowed",
      );

      if (entry.provider !== "custom")
        expect(
          codes(
            guard.evaluate(
              { ...input, issuer: "https://attacker.com" },
              { ...config, allowedIssuers: ["https://attacker.com"] },
            ).errors,
          ),
        ).toContain("provider_issuer_mismatch");
    }

    expect(
      codes(
        guard.evaluate(
          {
            ...policy,
            provider: "custom",
            issuer: "https://127.0.0.1",
            claims: { aud: ["cache"], sub: ["x"] },
          },
          settings,
        ).errors,
      ),
    ).toContain("unsafe_issuer");
    expect(
      codes(
        guard.evaluate(
          {
            ...policy,
            provider: "custom",
            claims: { aud: ["cache"], sub: ["repo:mutable/repo:ref:refs/heads/main"] },
          },
          settings,
        ).errors,
      ),
    ).toContain("provider_issuer_mismatch");
    const build = { ...policy, ...entries[2], claims: { aud: ["cache"], ...entries[2].claims } };
    expect(
      codes(guard.evaluate(build, { ...settings, allowedIssuers: [build.issuer] }).errors),
    ).toContain("untrusted_writes_forbidden");
  }));
