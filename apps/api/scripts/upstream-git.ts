export type RunGit = (
  args: string[],
  allowFailure?: boolean,
) => Promise<{ stdout: string; exit: number }>;

export const prepareReleaseBranch = async (
  run: RunGit,
  branch: string,
  base: string,
  commit: string,
  tag: string,
) => {
  const remoteBranch = await run(
    ["git", "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
    true,
  );

  let conflicted: boolean;

  if (remoteBranch.exit === 0) {
    // Resume a run whose push succeeded but whose PR creation failed.
    await run(["git", "fetch", "origin", `refs/heads/${branch}`]);
    await run(["git", "switch", "-C", branch, "FETCH_HEAD"]);
    conflicted =
      (await run(["git", "merge-base", "--is-ancestor", `origin/${base}`, "HEAD"], true)).exit !==
      0;
  } else {
    if (remoteBranch.exit !== 2) throw new Error("Could not check the existing sync branch");
    await run(["git", "switch", "-C", branch, `origin/${base}`]);

    const merge = await run(
      ["git", "merge", "--no-ff", commit, "-m", `Merge upstream ${tag}`],
      true,
    );

    conflicted = merge.exit !== 0;

    if (conflicted) {
      await run(["git", "merge", "--abort"]);
      // A branch at the tag still opens a reviewable PR with GitHub's conflict UI.
      await run(["git", "switch", "-C", branch, commit]);
    }

    await run(["git", "push", "origin", `HEAD:refs/heads/${branch}`]);
  }

  return conflicted;
};
