import { requireDestroyStage } from "./alchemy-stage.ts";
import { loadDeployConfig } from "./config.ts";
import { validateSigningKey } from "./signing-key.ts";

const [command, ...args] = Bun.argv.slice(2);

if (!command || !["deploy", "destroy", "plan", "dev"].includes(command)) {
  throw new Error("Expected dev, deploy, destroy, or plan");
}

const commandArgs = command === "destroy" ? requireDestroyStage(args) : args;
const config = await loadDeployConfig();
const explicitStage = commandArgs.some((arg) => arg === "--stage" || arg.startsWith("--stage="));
const stageArgs =
  explicitStage || Bun.env.ALCHEMY_STAGE || command === "dev"
    ? []
    : ["--stage", command === "plan" ? config.stages.staging : config.stages.production];

if (command !== "destroy") {
  await validateSigningKey(Bun.env.CACHE_TOKEN_SIGNING_KEY);
  const build = Bun.spawn(["bun", "run", "--cwd", "apps/dashboard", "build"], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await build.exited;

  if (exitCode !== 0) process.exit(exitCode);
}

const child = Bun.spawn(["alchemy", command, ...stageArgs, ...commandArgs], {
  cwd: new URL("../../../", import.meta.url).pathname,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
