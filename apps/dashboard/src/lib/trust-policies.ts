import { savePolicy } from "./credentials.ts";
import { listTrustPolicies } from "./projects.ts";
import type { GitHubRepository } from "./github.ts";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * The two policies the server also creates for `github` on project creation:
 * pushes to the default branch may write; pull requests read only.
 */
export const githubDefaultPolicies = (repo: GitHubRepository, audience: string) => {
  const identity = {
    aud: [audience],
    repository: [repo.repository],
    repository_id: [repo.repositoryId],
    repository_owner_id: [repo.repositoryOwnerId],
  };

  return [
    {
      provider: "github" as const,
      enabled: true,
      issuer: GITHUB_ISSUER,
      label: "GitHub default branch",
      ttlSeconds: 600,
      scope: "read write" as const,
      claims: { ...identity, ref: [`refs/heads/${repo.defaultBranch}`], event_name: ["push"] },
    },
    {
      provider: "github" as const,
      enabled: true,
      issuer: GITHUB_ISSUER,
      label: "GitHub pull requests",
      ttlSeconds: 600,
      scope: "read" as const,
      claims: { ...identity, sub: [`repo:${repo.repository}:pull_request`] },
    },
  ];
};

/** Resume a partial setup without changing an equivalent policy an admin already configured. */
export async function ensureGithubPolicies(
  projectId: string,
  repo: GitHubRepository,
  audience: string,
) {
  const existing = await listTrustPolicies(projectId);
  for (const policy of githubDefaultPolicies(repo, audience)) {
    const claims = Object.entries(policy.claims);
    const matches = existing.filter(
      (entry) =>
        entry.provider === policy.provider &&
        entry.issuer === policy.issuer &&
        entry.scope === policy.scope &&
        Object.keys(entry.claims).length === claims.length &&
        claims.every(([name, values]) => {
          const actual = entry.claims[name];
          return (
            actual?.length === values.length && values.every((value) => actual.includes(value))
          );
        }),
    );
    if (matches.some((entry) => entry.enabled)) continue;
    if (matches.length > 0)
      throw new Error(`${policy.label} is disabled. Enable it in Credentials to finish setup.`);
    await savePolicy(projectId, policy);
  }
}

export const githubWorkflow = (input: {
  readonly api: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly defaultBranch: string;
}) => `name: CI

on:
  push:
    branches: [${input.defaultBranch}]
  pull_request:

permissions:
  contents: read
  id-token: write # lets the job request an OIDC token; no cache secret needed

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<reviewed-full-commit-sha>
      - uses: res-fortuitae/turborepo-remote-cache-api/packages/action@<reviewed-full-commit-sha>
        with:
          api: ${input.api}
          team: ${input.orgId}
          project: ${input.projectId}
      - run: bunx turbo run build
`;
