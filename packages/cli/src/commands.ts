import { Effect } from "effect";
import { TokenCache, CiProvider, ClientConfig } from "@repo/client-core";
import { formatEnvironment, makeAuthRuntime, startProxy, turboEnvironment } from "./auth.ts";

const option = (args: string[], name: string) => {
  const index = args.indexOf(name);

  return index >= 0 ? args[index + 1] : undefined;
};

export const runAuthCommand = async (args: string[]) => {
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const command = separator < 0 ? [] : args.slice(separator + 1);
  const mode = args[0];
  const state = option(options, "--state");

  if (mode === "proxy-stop") {
    try {
      if (!state) throw new Error("state required");
      const value: unknown = await Bun.file(state).json();

      if (
        typeof value !== "object" ||
        value === null ||
        !("TURBO_API" in value) ||
        !("TURBO_TOKEN" in value) ||
        typeof value.TURBO_API !== "string" ||
        typeof value.TURBO_TOKEN !== "string" ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.TURBO_API)
      )
        throw new Error("invalid state");

      const response = await fetch(`${value.TURBO_API}/_tcache/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${value.TURBO_TOKEN}` },
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) throw new Error("stop failed");

      return 0;
    } catch {
      console.error("Unable to stop proxy using the supplied state file.");

      return 1;
    }
  }

  if (mode === "exec" && command.length === 0) {
    console.error("Usage: tcache exec [--strict] -- command [args]");

    return 1;
  }

  if (mode === "proxy" && !state) {
    console.error("Usage: tcache proxy --state <private-new-file>");

    return 1;
  }

  const runtime = makeAuthRuntime({
    api: option(options, "--api"),
    team: option(options, "--team"),
    project: option(options, "--project"),
    audience: option(options, "--audience"),
    strict: options.includes("--strict") ? true : undefined,
    boundTokens:
      !["env", "ci-auth", "token"].includes(mode ?? "") && !options.includes("--unbound-tokens"),
  });

  let proxy: Awaited<ReturnType<typeof startProxy>>;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let removeState = false;
  let finish: (() => void) | undefined;

  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const shutdown = () => {
    child?.kill();
    finish?.();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const spawn = (env: Record<string, string | undefined>) => {
    child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });

    return child.exited;
  };

  try {
    if (mode === "ci-auth") {
      const eligible = await runtime.runPromise(
        Effect.gen(function* () {
          const provider = yield* CiProvider;
          const config = yield* ClientConfig;
          return (yield* provider.detect) !== undefined || config.apiKey !== undefined;
        }),
      );
      if (!eligible) {
        console.error(
          "No CI identity or API key configured; developer sessions are not used by ci-auth.",
        );
        return 1;
      }
    }
    if (mode === "env" || mode === "token" || mode === "ci-auth") {
      const credential = await runtime.runPromise(Effect.flatMap(TokenCache, (cache) => cache.get));

      if (credential === undefined) {
        console.error("No cache credential available; no environment emitted.");

        return ["token", "ci-auth"].includes(mode ?? "") || options.includes("--strict") ? 1 : 0;
      }

      console.log(
        mode === "token"
          ? turboEnvironment(credential).TURBO_TOKEN
          : formatEnvironment(turboEnvironment(credential), option(options, "--format") ?? "shell"),
      );

      return 0;
    }

    try {
      proxy = await startProxy(runtime, shutdown);
    } catch {
      if (
        options.includes("--strict") ||
        Bun.env.TCACHE_STRICT === "true" ||
        Bun.env.TCACHE_STRICT === "1"
      )
        throw new Error("strict auth failure");
      console.error("Remote cache disabled: unable to initialize authentication.");
    }

    if (proxy === undefined) {
      if (mode === "proxy") {
        console.error("Proxy not started: no cache credential available.");

        return 1;
      }

      return await spawn({
        ...Bun.env,
        TURBO_API: "http://127.0.0.1:1",
        TURBO_TOKEN: "",
        TURBO_REMOTE_CACHE_SIGNATURE_KEY: undefined,
        TURBO_REMOTE_ONLY: undefined,
        TURBO_CACHE: "local:rw",
      });
    }

    if (mode === "exec")
      return await spawn({ ...Bun.env, TCACHE_API_KEY: undefined, ...proxy.environment });
    // Publish a fully written file atomically without replacing an existing path/symlink.
    const { open, unlink, link } = await import("node:fs/promises");
    const temporary = `${state!}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(proxy.environment));
      } finally {
        await file.close();
      }
      await link(temporary, state!);
      removeState = true;
    } finally {
      await unlink(temporary);
    }

    await done;
    await unlink(state!);
    removeState = false;

    return 0;
  } catch {
    console.error(
      "Cache authentication command failed. Check configuration, identity permissions and state file path.",
    );

    return 1;
  } finally {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    child?.kill();

    if (proxy) {
      proxy.stop();
      console.error(`Cache stats: ${JSON.stringify(await proxy.stats())}`);
    }

    if (removeState && state)
      await Bun.file(state)
        .unlink()
        .catch(() => undefined);
    await runtime.dispose();
  }
};
