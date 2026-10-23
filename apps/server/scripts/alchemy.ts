import { loadDeployConfig } from "./config.ts";

const [command, ...args] = Bun.argv.slice(2);

if (!command || !["deploy", "destroy", "plan", "dev"].includes(command)) {
  throw new Error("Expected dev, deploy, destroy, or plan");
}

const config = await loadDeployConfig();
const explicitStage = args.some((arg) => arg === "--stage" || arg.startsWith("--stage="));
const defaultStage = command === "plan" ? config.stages.staging : config.stages.production;

const stageArgs =
  explicitStage || Bun.env.ALCHEMY_STAGE || command === "dev" ? [] : ["--stage", defaultStage];

const child = Bun.spawn(["alchemy", command, ...stageArgs, ...args], {
  cwd: new URL("../../../", import.meta.url).pathname,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
