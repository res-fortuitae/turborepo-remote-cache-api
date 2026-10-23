import * as NodeFSP from "node:fs/promises";
import { configUrl, loadDeployConfig } from "./config.ts";
import { defineDeployConfig, type DeployConfig } from "../src/deploy-config.ts";

export const writeDeployConfig = async (url: URL, config: DeployConfig) => {
  const validated = defineDeployConfig(config);
  const source = `import { defineDeployConfig } from "./apps/server/src/deploy-config.ts";\n\nexport default defineDeployConfig(${JSON.stringify(validated, null, 2)});\n`;
  // Exclusive creation protects organization config on reruns and concurrent setup.
  await NodeFSP.writeFile(url, source, { flag: "wx" });
};

const ask = (question: string, fallback: string) => {
  const answer = prompt(`${question} [${fallback}]`);

  if (answer === null) throw new Error("Setup cancelled; no configuration was written");

  return answer.trim() || fallback;
};

export const setup = async () => {
  if (await Bun.file(configUrl).exists()) {
    await loadDeployConfig();
    console.log("Using existing deploy.config.ts; no values were overwritten.");
  } else {
    const domain = ask("Production domain (leave blank for workers.dev)", "");
    const jurisdiction = ask("R2 jurisdiction: default, eu, fedramp", "default");

    if (!["default", "eu", "fedramp"].includes(jurisdiction)) {
      throw new Error("Jurisdiction must be default, eu, or fedramp");
    }

    const edgeCache = ask("Enable edge caching? yes/no", "yes");

    if (!["yes", "no"].includes(edgeCache)) throw new Error("Answer yes or no");

    const production = ask(
      "Production stage (existing installs: use your current Alchemy stage)",
      "production",
    );

    const staging = ask("Staging stage", "staging");
    await writeDeployConfig(
      configUrl,
      defineDeployConfig({
        domain: domain || undefined,
        // SAFETY: the input was checked against this exact union above.
        jurisdiction: jurisdiction as DeployConfig["jurisdiction"],
        limits: { artifactRetentionDays: 30 },
        features: { edgeCache: edgeCache === "yes" },
        stages: { production, staging },
      }),
    );
    console.log("Created deploy.config.ts. Keep secrets in the root .env or a secret store.");
  }

  const pkg = await Bun.file(new URL("../../../package.json", import.meta.url)).json();

  if (pkg.scripts.bootstrap) {
    const child = Bun.spawn(["bun", "run", "bootstrap"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    if ((await child.exited) !== 0)
      throw new Error("Bootstrap failed; config was preserved for retry");
  } else {
    console.log(
      "Bootstrap is pending STV-499. Configuration is ready; no infrastructure was deployed.",
    );
  }
};

if (import.meta.main) await setup();
