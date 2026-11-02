import { fileURLToPath } from "node:url";

const node = Bun.spawnSync(["node", "--version"]);
if (node.exitCode !== 0) throw new Error("Node is required for workspace tasks.");

const child = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(new URL("../node_modules/turbo/bin/turbo", import.meta.url)),
    "run",
    ...Bun.argv.slice(2),
  ],
  {
    env: {
      ...Bun.env,
      TCACHE_PLATFORM: `${process.platform}-${process.arch}`,
      TCACHE_RUNTIME: `bun-${Bun.version}-node-${node.stdout.toString().trim()}`,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exitCode = await child.exited;
