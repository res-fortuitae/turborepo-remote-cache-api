import { expect, test } from "bun:test";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const plan = async (args: string[], platform = "darwin-arm64") => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, "node_modules/turbo/bin/turbo"),
      "run",
      ...args,
      "--cache=local:rw",
      "--dry=json",
    ],
    {
      cwd: root,
      env: { ...Bun.env, TCACHE_PLATFORM: platform, TCACHE_RUNTIME: "cache-key-fixture" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const value: { tasks: { taskId: string; hash: string }[] } = JSON.parse(stdout);
  return Object.fromEntries(value.tasks.map((task) => [task.taskId, task.hash]));
};

test("generated config logs and dependencies do not invalidate typecheck cache keys", async () => {
  const paths = [".turbo", "node_modules"].map((directory) =>
    join(root, "packages/config", directory, `cache-key-fixture-${crypto.randomUUID()}`),
  );
  const before = await plan(["typecheck", "--filter=@repo/config"]);
  try {
    for (const path of paths) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "generated cache-key fixture", { flag: "wx" });
    }
    expect(await plan(["typecheck", "--filter=@repo/config"])).toEqual(before);
  } finally {
    await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)));
  }
});

test("native builds and tests separate platforms while portable builds share keys", async () => {
  const args = ["build", "test", "--filter=@repo/cli", "--filter=@repo/dashboard"];
  const mac = await plan(args, "darwin-arm64");
  const linux = await plan(args, "linux-x64");
  expect(mac["@repo/cli#build"]).not.toBe(linux["@repo/cli#build"]);
  expect(mac["@repo/cli#test"]).not.toBe(linux["@repo/cli#test"]);
  expect(mac["@repo/dashboard#build"]).toBe(linux["@repo/dashboard#build"]);
});
