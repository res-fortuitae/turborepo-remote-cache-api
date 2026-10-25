/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun test boundary. */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { TrustPolicy } from "@repo/db";
import { TrustPolicyMatcher, TrustPolicyMatcherTest } from "./index.ts";

const policy: TrustPolicy = {
  id: "p",
  projectId: "project",
  provider: "github",
  enabled: true,
  createdBy: "u",
  createdAt: 0,
  body: {
    issuer: "https://token.actions.githubusercontent.com",
    claims: { aud: ["cache"], repository: ["org/repo"] },
    scope: "read write",
    ttlSeconds: 600,
  },
};

const project = { id: "project", archivedAt: null };

const claims = {
  iss: policy.body.issuer,
  aud: ["other", "cache"],
  repository: "org/repo",
  ref: "refs/heads/main",
};

const run = (task: (matcher: typeof TrustPolicyMatcher.Service) => void) =>
  Effect.runPromise(
    Effect.gen(function* () {
      task(yield* TrustPolicyMatcher);
    }).pipe(Effect.provide(TrustPolicyMatcherTest)),
  );

test("exact issuer and every claim rule; array intersections; no identity glob expansion", () =>
  run((matcher) => {
    expect(matcher.match(project, [policy], claims)).toMatchObject({
      matched: true,
      scope: "read write",
      ttlSeconds: 600,
    });

    for (const changed of [
      { ...claims, repository: "org/other" },
      { ...claims, repository: undefined },
      { ...claims, aud: "wrong" },
      { ...claims, iss: `${claims.iss}/` },
      { ...claims, repository: 123 },
    ])
      expect(matcher.match(project, [policy], changed)).toMatchObject({ matched: false });
    expect(
      matcher.match(
        project,
        [
          {
            ...policy,
            body: { ...policy.body, claims: { aud: ["cache"], repository: ["org/*"] } },
          },
        ],
        claims,
      ),
    ).toMatchObject({ matched: false });
  }));

test("invalid stored policies, disabled/foreign policies and deleted projects fail closed", () =>
  run((matcher) => {
    for (const body of [
      { ...policy.body, claims: {} },
      { ...policy.body, claims: { sub: ["x"] } },
      { ...policy.body, issuer: "http://issuer" },
      { ...policy.body, issuer: `${claims.iss}?` },
      { ...policy.body, ttlSeconds: 0 },
    ])
      expect(matcher.match(project, [{ ...policy, body }], claims)).toMatchObject({
        matched: false,
      });
    expect(
      matcher.match(
        project,
        [
          { ...policy, enabled: false },
          { ...policy, projectId: "other" },
        ],
        claims,
      ),
    ).toEqual({ matched: false, closest: null });
    expect(matcher.match({ ...project, deleted: true }, [policy], claims)).toEqual({
      matched: false,
      closest: null,
    });
  }));

test("overlap takes restrictive scope, TTL and binding; archives force read-only", () =>
  run((matcher) => {
    const strict = {
      ...policy,
      id: "strict",
      body: { ...policy.body, scope: "read" as const, ttlSeconds: 60, requireBoundTokens: true },
    };

    for (const policies of [
      [policy, strict],
      [strict, policy],
    ])
      expect(matcher.match(project, policies, claims)).toMatchObject({
        matched: true,
        scope: "read",
        ttlSeconds: 60,
        requireBoundTokens: true,
      });
    expect(matcher.match({ ...project, archivedAt: 1 }, [policy], claims)).toMatchObject({
      matched: true,
      scope: "read",
    });
  }));

test("refPatterns is an additional ref/branch-only constraint; denials identify closest policy", () =>
  run((matcher) => {
    const patterned = {
      ...policy,
      body: { ...policy.body, refPatterns: ["refs/heads/release-?"] },
    };

    expect(
      matcher.match(project, [patterned], { ...claims, ref: "refs/heads/release-1" }),
    ).toMatchObject({ matched: true });
    expect(
      matcher.match(project, [patterned], { ...claims, ref: "refs/heads/release-12" }),
    ).toMatchObject({ matched: false });
    expect(
      matcher.match(project, [patterned], {
        ...claims,
        ref: undefined,
        branch: "refs/heads/release-a",
      }),
    ).toMatchObject({ matched: true });
    expect(matcher.match(project, [patterned], { ...claims, ref: undefined })).toEqual({
      matched: false,
      closest: { policyId: "p", failedClaims: ["refPatterns"] },
    });
    expect(matcher.match(project, [policy], { ...claims, repository: "other" })).toEqual({
      matched: false,
      closest: { policyId: "p", failedClaims: ["repository"] },
    });
  }));

test("boolean claim conditions stay exact and provider ref fields participate in ref patterns", () =>
  run((matcher) => {
    for (const field of ["build_branch", "branchName", "oidc.circleci.com/vcs-ref"]) {
      const input = {
        ...policy,
        body: {
          ...policy.body,
          claims: { aud: ["cache"], "oidc.circleci.com/ssh-rerun": ["false"] },
          refPatterns: ["main"],
        },
      };
      expect(
        matcher.match(project, [input], {
          iss: claims.iss,
          aud: "cache",
          "oidc.circleci.com/ssh-rerun": false,
          [field]: "main",
        }).matched,
      ).toBe(true);
      expect(
        matcher.match(project, [input], {
          iss: claims.iss,
          aud: "cache",
          "oidc.circleci.com/ssh-rerun": true,
          [field]: "main",
        }).matched,
      ).toBe(false);
      expect(
        matcher.match(project, [input], {
          iss: claims.iss,
          aud: "cache",
          "oidc.circleci.com/ssh-rerun": false,
          [field]: "other",
        }).matched,
      ).toBe(false);
    }
  }));
