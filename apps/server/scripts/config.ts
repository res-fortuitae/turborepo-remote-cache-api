import { defineDeployConfig } from "../src/deploy-config.ts";

export const configUrl = new URL("../../../deploy.config.ts", import.meta.url);

/** The shared contract suite tests legacy migration behavior only in explicit local test runs. */
export const localTestConfig = (
  config: ReturnType<typeof defineDeployConfig>,
  test: string | undefined,
  dev: string | undefined,
) =>
  test === "1" && dev === "1"
    ? { ...config, features: { ...config.features, legacyToken: true } }
    : config;

export const loadDeployConfig = async (url = configUrl) => {
  if (!(await Bun.file(url).exists())) {
    throw new Error("Missing deploy.config.ts. Run `bun run setup` from the repository root.");
  }

  const module = await import(url.href);

  return localTestConfig(
    defineDeployConfig(module.default),
    Bun.env.ALCHEMY_TEST,
    Bun.env.ALCHEMY_TEST_DEV,
  );
};
