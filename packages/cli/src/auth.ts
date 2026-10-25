import { BunFileSystem } from "@effect/platform-bun";
import {
  CacheProxy,
  CacheProxyLive,
  ClientCoreLive,
  ClientEnvironment,
  ClientOptions,
  ClientMessages,
  ClientCommand,
  ClientAuthError,
  DeveloperCredentialsUnavailable,
  TokenCache,
  ProxyTransport,
  ProxySession,
  type ClientFlags,
  type ClientCredential,
} from "@repo/client-core";
import { Effect, Layer, Redacted, ManagedRuntime } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

export const makeAuthRuntime = (flags: ClientFlags = {}) => {
  const adapters = Layer.mergeAll(
    BunFileSystem.layer,
    FetchHttpClient.layer,
    DeveloperCredentialsUnavailable,
    Layer.succeed(ClientEnvironment, { get: (name) => Bun.env[name] }),
    Layer.succeed(ClientOptions, { flags }),
    Layer.succeed(ClientMessages, {
      warn: (message) => Effect.sync(() => console.error(message)),
      mask: () => Effect.void,
    }),
    Layer.succeed(ClientCommand, {
      run: (executable, args) =>
        Effect.tryPromise({
          try: async () => {
            const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "ignore" });
            const timer = setTimeout(() => child.kill(), 10_000);

            try {
              const reader = child.stdout.getReader();
              let value = "";
              let bytes = 0;
              const decoder = new TextDecoder();

              for (;;) {
                const chunk = await reader.read();

                if (chunk.done) break;
                bytes += chunk.value.length;

                if (bytes > 16_384) {
                  child.kill();
                  throw new Error("bounded command output");
                }

                value += decoder.decode(chunk.value, { stream: true });
              }

              if ((await child.exited) !== 0) throw new Error("command failed");

              return value + decoder.decode();
            } finally {
              clearTimeout(timer);
              child.kill();
            }
          },
          catch: () =>
            new ClientAuthError({
              reason: "provider",
              message:
                "CI token command failed. Check the provider CLI installation and permissions.",
            }),
        }),
    }),
    Layer.succeed(ProxyTransport, {
      send: (request) =>
        Effect.tryPromise({
          try: () => fetch(request, { redirect: "manual", decompress: false }),
          catch: () => "upstream unavailable",
        }),
    }),
    Layer.sync(ProxySession, () => ({
      secret: Redacted.make(crypto.randomUUID() + crypto.randomUUID()),
    })),
  );

  return ManagedRuntime.make(
    CacheProxyLive.pipe(Layer.provideMerge(ClientCoreLive), Layer.provideMerge(adapters)),
  );
};

export const turboEnvironment = (credential: ClientCredential) => ({
  TURBO_API: credential.api,
  TURBO_TEAM: credential.team,
  TURBO_TOKEN: Redacted.value(credential.token),
  ...(credential.source !== "apiKey" && credential.signatureKey !== undefined
    ? { TURBO_REMOTE_CACHE_SIGNATURE_KEY: Redacted.value(credential.signatureKey) }
    : {}),
});

/** Env output intentionally contains credentials. Reject all control characters before line formats. */
export const formatEnvironment = (values: Record<string, string>, format: string) => {
  if (format === "json") return JSON.stringify(values);

  if (Object.values(values).some((value) => /[\x00-\x1f\x7f]/.test(value)))
    throw new Error("Unsafe environment value");

  if (["github", "gitlab", "dotenv"].includes(format)) {
    if (Object.values(values).some((value) => /[\s'"`$\\#]/.test(value)))
      throw new Error("Unsafe line environment value");

    return Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  }

  if (format === "shell")
    return Object.entries(values)
      .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`)
      .join("\n");
  throw new Error("Unknown environment format");
};

export const startProxy = async (
  runtime: ReturnType<typeof makeAuthRuntime>,
  onStop: () => void = () => undefined,
) => {
  const credential = await runtime.runPromise(Effect.flatMap(TokenCache, (cache) => cache.get));

  if (credential === undefined) return undefined;
  const proxy = await runtime.runPromise(CacheProxy);
  const session = await runtime.runPromise(ProxySession);
  const secret = Redacted.value(session.secret);
  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    // Stream arbitrary artifacts without imposing Bun's small default body ceiling.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch: async (request) => {
      if (
        new URL(request.url).pathname === "/_tcache/stop" &&
        request.method === "POST" &&
        request.headers.get("authorization") === `Bearer ${secret}`
      ) {
        setTimeout(onStop, 25);

        return new Response(null, { status: 204 });
      }

      return runtime
        .runPromise(proxy.handle(request), { signal: request.signal })
        .catch(() => new Response(null, { status: 502 }));
    },
  });
  let refreshing = false;

  const timer = setInterval(() => {
    if (refreshing) return;
    refreshing = true;
    void runtime
      .runPromise(Effect.flatMap(TokenCache, (cache) => cache.get))
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  }, 1000);

  return {
    environment: {
      ...turboEnvironment(credential),
      TURBO_API: `http://127.0.0.1:${server.port}`,
      TURBO_TOKEN: secret,
    },
    stats: () => runtime.runPromise(proxy.stats),
    stop: () => {
      clearInterval(timer);
      void server.stop(true);
    },
  };
};
