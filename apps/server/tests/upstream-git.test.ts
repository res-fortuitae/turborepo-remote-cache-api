import { afterEach, expect, test } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { prepareReleaseBranch, type RunGit } from "../scripts/upstream-git.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

const fixture = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "upstream-git-test-"));
  directories.push(root);
  const remote = NodePath.join(root, "origin.git");
  const cwd = NodePath.join(root, "fork");
  await NodeFSP.mkdir(cwd);

  const run: RunGit = async (args, allowFailure = false) => {
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });

    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (exit !== 0 && !allowFailure) throw new Error(stderr);

    return { stdout: stdout.trim(), exit };
  };

  await run(["git", "init", "--bare", remote]);
  await run(["git", "init", "-b", "main"]);
  await run(["git", "config", "user.name", "Sync test"]);
  await run(["git", "config", "user.email", "sync@example.com"]);
  await run(["git", "config", "commit.gpgsign", "false"]);
  await Bun.write(NodePath.join(cwd, "api.ts"), "old upstream\n");
  await run(["git", "add", "."]);
  await run(["git", "commit", "-m", "Initial upstream"]);
  await run(["git", "remote", "add", "origin", remote]);
  await run(["git", "switch", "-c", "release"]);
  await Bun.write(NodePath.join(cwd, "api.ts"), "new upstream\n");
  await run(["git", "commit", "-am", "Upstream release"]);
  const commit = (await run(["git", "rev-parse", "HEAD"])).stdout;
  await run(["git", "switch", "main"]);
  await Bun.write(NodePath.join(cwd, "deploy.config.ts"), "organization config\n");
  await NodeFSP.mkdir(NodePath.join(cwd, "custom"));
  await Bun.write(NodePath.join(cwd, "custom", "policy.txt"), "organization policy\n");
  await run(["git", "add", "."]);
  await run(["git", "commit", "-m", "Configure fork"]);
  await run(["git", "push", "-u", "origin", "main"]);

  return { run, cwd, commit };
};

test("release merge preserves config/custom and retries reuse the pushed branch", async () => {
  const { run, cwd, commit } = await fixture();
  expect(await prepareReleaseBranch(run, "upstream-sync/v1.0.0", "main", commit, "v1.0.0")).toBe(
    false,
  );
  expect(await Bun.file(NodePath.join(cwd, "api.ts")).text()).toBe("new upstream\n");
  expect(await Bun.file(NodePath.join(cwd, "deploy.config.ts")).text()).toBe(
    "organization config\n",
  );
  expect(await Bun.file(NodePath.join(cwd, "custom", "policy.txt")).text()).toBe(
    "organization policy\n",
  );
  const head = (await run(["git", "rev-parse", "HEAD"])).stdout;
  expect(await prepareReleaseBranch(run, "upstream-sync/v1.0.0", "main", commit, "v1.0.0")).toBe(
    false,
  );
  expect((await run(["git", "rev-parse", "HEAD"])).stdout).toBe(head);
});

test("conflicting upstream code leaves a tag branch for a reviewable PR", async () => {
  const { run, cwd, commit } = await fixture();
  await Bun.write(NodePath.join(cwd, "api.ts"), "organization override\n");
  await run(["git", "commit", "-am", "Override upstream code"]);
  await run(["git", "push", "origin", "main"]);
  expect(await prepareReleaseBranch(run, "upstream-sync/v1.0.0", "main", commit, "v1.0.0")).toBe(
    true,
  );
  expect((await run(["git", "rev-parse", "HEAD"])).stdout).toBe(commit);
  expect((await run(["git", "show", "origin/main:deploy.config.ts"])).stdout).toBe(
    "organization config",
  );
  expect((await run(["git", "status", "--porcelain"])).stdout).toBe("");
});
