/** Immutable identifiers a GitHub trust policy must pin (STV-487 guardrails). */
export interface GitHubRepository {
  readonly repository: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly defaultBranch: string;
}

export const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Public repositories resolve through GitHub's unauthenticated REST API from
 * the browser. Private repositories return 404; enter their IDs manually.
 */
export async function lookupRepository(repository: string): Promise<GitHubRepository> {
  if (!repositoryPattern.test(repository))
    throw new Error("Use the owner/name form, e.g. acme/web.");
  const response = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: { accept: "application/vnd.github+json" },
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });

  if (response.status === 404)
    throw new Error("Repository not found. Private repositories need their IDs entered manually.");

  if (!response.ok) throw new Error("GitHub is unavailable. Enter the repository IDs manually.");
  const body = (await response.json()) as {
    full_name?: unknown;
    id?: unknown;
    owner?: { id?: unknown };
    default_branch?: unknown;
  };

  if (
    typeof body.full_name !== "string" ||
    typeof body.id !== "number" ||
    typeof body.owner?.id !== "number" ||
    typeof body.default_branch !== "string"
  )
    throw new Error("GitHub returned an unexpected response.");

  return {
    repository: body.full_name,
    repositoryId: String(body.id),
    repositoryOwnerId: String(body.owner.id),
    defaultBranch: body.default_branch,
  };
}

/** The command that prints a private repository's IDs with the GitHub CLI. */
export const idsCommand = (repository: string) =>
  `gh api repos/${repository || "OWNER/REPO"} --jq '.id, .owner.id, .default_branch'`;
