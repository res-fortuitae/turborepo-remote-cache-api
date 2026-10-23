import { prepareReleaseBranch } from "./upstream-git.ts";
import { isReleaseTag, migrationNotes, releasePullRequestBody, type Release } from "./releases.ts";

const root = new URL("../../../", import.meta.url).pathname;

const run = async (args: string[], allowFailure = false) => {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exit !== 0 && !allowFailure) throw new Error(`${args[0]} failed: ${stderr}`);

  return { stdout: stdout.trim(), exit };
};

const api = async (path: string) => JSON.parse((await run(["gh", "api", path])).stdout);
const repo = Bun.env.GITHUB_REPOSITORY;

if (!repo) throw new Error("GITHUB_REPOSITORY is required");

if (!Bun.env.CI) throw new Error("Upstream sync must run in an isolated CI checkout");

const repository = await api(`repos/${repo}`);
const upstream = Bun.env.UPSTREAM_REPOSITORY || repository.parent?.full_name;

if (!upstream || !/^[\w.-]+\/[\w.-]+$/.test(upstream) || upstream === repo) {
  throw new Error("Set UPSTREAM_REPOSITORY to owner/repo, or run this workflow in a GitHub fork");
}

const pages = JSON.parse(
  (await run(["gh", "api", "--paginate", "--slurp", `repos/${upstream}/releases?per_page=100`]))
    .stdout,
);

// SAFETY: GitHub's releases endpoint returns this documented response shape.
const releases = (pages.flat() as Release[])
  .filter((release) => !release.draft && !release.prerelease && isReleaseTag(release.tag_name))
  .sort((a, b) => a.published_at.localeCompare(b.published_at));

await run(["git", "config", "user.name", "github-actions[bot]"]);

await run(["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);

const base = repository.default_branch;

for (const release of releases) {
  const branch = `upstream-sync/${release.tag_name}`;

  const existing = await api(
    `repos/${repo}/pulls?state=all&head=${repository.owner.login}:${branch}`,
  );

  // Closing a sync PR is an explicit opt-out for that release, too.
  if (existing.length) continue;
  await run([
    "git",
    "fetch",
    `https://github.com/${upstream}.git`,
    `refs/tags/${release.tag_name}`,
  ]);
  const commit = (await run(["git", "rev-parse", "FETCH_HEAD^{commit}"])).stdout;

  if (
    (await run(["git", "merge-base", "--is-ancestor", commit, `origin/${base}`], true)).exit === 0
  )
    continue;

  const notes = migrationNotes(
    (await run(["git", "show", `${commit}:UPGRADING.md`])).stdout,
    release.tag_name,
  );

  const conflicted = await prepareReleaseBranch(run, branch, base, commit, release.tag_name);

  const body = releasePullRequestBody(release, notes, conflicted);
  const bodyFile = `${Bun.env.RUNNER_TEMP}/upstream-sync-body.md`;
  await Bun.write(bodyFile, body);
  await run([
    "gh",
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    base,
    "--head",
    branch,
    "--title",
    `chore: sync upstream ${release.tag_name}`,
    "--body-file",
    bodyFile,
  ]);
}
