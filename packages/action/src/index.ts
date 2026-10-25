import * as core from "@actions/core";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import { TokenCache } from "@repo/client-core";
import { actionRuntime } from "./runtime.ts";

const Environment = Schema.Struct({
  TURBO_API: Schema.NonEmptyString,
  TURBO_TEAM: Schema.NonEmptyString,
  TURBO_TOKEN: Schema.NonEmptyString,
  TURBO_REMOTE_CACHE_SIGNATURE_KEY: Schema.optional(Schema.NonEmptyString),
});

export type TurboEnvironment = typeof Environment.Type;

const decodeEnvironment = Schema.decodeUnknownSync(Environment);

const exportEnvironment = (values: TurboEnvironment) => {
  core.setSecret(values.TURBO_TOKEN);

  if (values.TURBO_REMOTE_CACHE_SIGNATURE_KEY)
    core.setSecret(values.TURBO_REMOTE_CACHE_SIGNATURE_KEY);

  for (const [key, value] of Object.entries(values))
    if (value !== undefined) core.exportVariable(key, value);
};

const disable = () => {
  core.exportVariable("TURBO_CACHE", "local:rw");
  core.exportVariable("TURBO_TOKEN", "");
  core.exportVariable("TURBO_API", "http://127.0.0.1:1");
  core.exportVariable("TURBO_REMOTE_CACHE_SIGNATURE_KEY", "");
};

export const run = async () => {
  let strict = false;
  let directory: string | undefined;
  let daemon: ReturnType<typeof fork> | undefined;

  try {
    strict = core.getBooleanInput("strict") || false;
    const api = core.getInput("api", { required: true });
    const team = core.getInput("team", { required: true });
    const project = core.getInput("project", { required: true });
    const mode = core.getInput("mode") || "proxy";

    if (!["proxy", "env"].includes(mode)) throw new Error("invalid mode");

    if (mode === "env") {
      const runtime = actionRuntime(
        { api, team, project, boundTokens: false, strict: true },
        { warn: core.warning, mask: core.setSecret },
      );

      try {
        const credential = await runtime.runPromise(
          Effect.flatMap(TokenCache, (cache) => cache.get),
        );

        if (!credential) throw new Error("credential unavailable");
        exportEnvironment({
          TURBO_API: credential.api,
          TURBO_TEAM: credential.team,
          TURBO_TOKEN: Redacted.value(credential.token),
          ...(credential.source !== "apiKey" && credential.signatureKey !== undefined
            ? { TURBO_REMOTE_CACHE_SIGNATURE_KEY: Redacted.value(credential.signatureKey) }
            : {}),
        });
      } finally {
        await runtime.dispose();
      }

      return;
    }

    directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "tcache-action-"));
    core.saveState("directory", directory);
    daemon = fork(join(dirname(process.argv[1]!), "daemon.cjs"), [], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
      env: { ...process.env, INPUT_API: api, INPUT_TEAM: team, INPUT_PROJECT: project },
    });
    const child = daemon;

    const values = await new Promise<TurboEnvironment>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("proxy startup timeout")), 20_000);

      const finish = () => {
        clearTimeout(timer);
        child.removeAllListeners("message");
        child.removeAllListeners("exit");
        child.removeAllListeners("error");
      };

      child.once("error", () => {
        finish();
        reject(new Error("proxy startup failed"));
      });
      child.once("exit", () => {
        finish();
        reject(new Error("proxy exited before ready"));
      });
      child.on("message", (input: unknown) => {
        if (typeof input !== "object" || input === null || !("type" in input)) return;

        if (input.type === "mask" && "value" in input && typeof input.value === "string")
          core.setSecret(input.value);

        if (input.type === "failure") {
          finish();
          reject(
            new Error(
              "Cache identity denied. Check id-token: write, policy and fork PR restrictions.",
            ),
          );
        }

        if (input.type === "ready" && "environment" in input) {
          try {
            const environment = decodeEnvironment(input.environment);
            finish();
            resolve(environment);
          } catch {
            finish();
            reject(new Error("invalid proxy startup response"));
          }
        }
      });
    });

    await writeFile(join(directory, "session.json"), JSON.stringify(values), {
      flag: "wx",
      mode: 0o600,
    });
    exportEnvironment(values);
    child.disconnect();
    child.unref();
    daemon = undefined;
  } catch (error) {
    daemon?.kill();

    if (daemon?.connected) daemon.disconnect();
    daemon?.unref();

    if (directory) await rm(directory, { recursive: true, force: true });
    disable();

    const message =
      error instanceof Error && error.message.startsWith("Cache identity denied")
        ? error.message
        : "Remote cache disabled. Check Action inputs, id-token: write permission, network and trust policy; fork PRs may be restricted.";

    if (strict) core.setFailed(message);
    else core.warning(message);
  }
};
