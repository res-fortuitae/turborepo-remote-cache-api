import { defineDeployConfig } from "../src/deploy-config.ts";

export const configUrl = new URL("../../../deploy.config.ts", import.meta.url);

export const loadDeployConfig = async (url = configUrl) => {
  if (!(await Bun.file(url).exists())) {
    throw new Error("Missing deploy.config.ts. Run `bun run setup` from the repository root.");
  }

  const module = await import(url.href);

  return defineDeployConfig(module.default);
};
