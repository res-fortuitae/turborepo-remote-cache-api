import { Context, Effect, Layer, Redacted } from "effect";
import { TokenCache } from "./token-cache.ts";
import { DpopSigner } from "./dpop.ts";
import { ClientConfig } from "./config.ts";

/** Host supplies a streaming HTTP transport; it must not follow redirects. */
export class ProxyTransport extends Context.Service<
  ProxyTransport,
  {
    readonly send: (request: Request) => Effect.Effect<Response, unknown>;
  }
>()("@repo/client-core/ProxyTransport") {}

export class ProxySession extends Context.Service<
  ProxySession,
  {
    readonly secret: Redacted.Redacted<string>;
  }
>()("@repo/client-core/ProxySession") {}

const headersFor = (source: Headers) => {
  const headers = new Headers();

  for (const name of [
    "content-type",
    "content-length",
    "x-artifact-tag",
    "x-artifact-sha",
    "x-artifact-dirty-hash",
    "x-artifact-duration",
    "x-artifact-client-ci",
    "x-artifact-client-interactive",
    "user-agent",
    "range",
    "if-none-match",
  ]) {
    const value = source.get(name);

    if (value !== null) headers.set(name, value);
  }

  return headers;
};

const equal = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;

  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);

  return difference === 0;
};

const make = Effect.gen(function* () {
  const cache = yield* TokenCache;
  const config = yield* ClientConfig;
  const transport = yield* ProxyTransport;
  const session = yield* ProxySession;
  const signer = yield* DpopSigner;
  const stats = { hits: 0, misses: 0, uploads: 0, errors: 0, retries: 0 };

  return {
    stats: Effect.sync(() => ({ ...stats })),
    handle: Effect.fn("CacheProxy.handle")(function* (request: Request) {
      if (
        !equal(
          request.headers.get("authorization") ?? "",
          `Bearer ${Redacted.value(session.secret)}`,
        )
      )
        return new Response(null, { status: 401 });
      const incoming = new URL(request.url);

      if (
        !/^\/v8\/artifacts(?:\/[^/]+)?$/.test(incoming.pathname) ||
        !["GET", "HEAD", "PUT", "POST"].includes(request.method)
      )
        return new Response(null, { status: 404 });
      const credential = yield* cache.peek;

      if (credential === undefined) return new Response(null, { status: 503 });
      const target = new URL(incoming.pathname + incoming.search, config.api);
      // Only safe reads can be retried: upload streams and event batches cannot be replayed.
      const attempts = ["GET", "HEAD"].includes(request.method) ? 3 : 1;

      for (let attempt = 0; attempt < attempts; attempt++) {
        const headers = headersFor(request.headers);
        headers.set(
          "authorization",
          `${config.boundTokens && credential.source !== "apiKey" ? "DPoP" : "Bearer"} ${Redacted.value(credential.token)}`,
        );

        if (config.boundTokens && credential.source !== "apiKey") {
          const proof = yield* signer.proof({
            url: target.href,
            method: request.method,
            accessToken: credential.token,
          });
          headers.set("dpop", Redacted.value(proof));
        }

        const init: RequestInit & { duplex: "half" } = {
          duplex: "half",
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
          redirect: "manual",
          signal: request.signal,
        };
        const upstream = new Request(target.href, init);

        const response = yield* transport
          .send(upstream)
          .pipe(Effect.catch(() => Effect.succeed(new Response(null, { status: 502 }))));

        if (
          [502, 503, 504].includes(response.status) &&
          attempt + 1 < attempts &&
          !request.signal.aborted
        ) {
          yield* Effect.promise(async () => {
            await response.body?.cancel();
          });
          stats.retries++;
          yield* Effect.sleep(`${50 * (attempt + 1)} millis`);
          continue;
        }

        if (response.status >= 500) stats.errors++;

        if (
          ["GET", "HEAD"].includes(request.method) &&
          incoming.pathname !== "/v8/artifacts/status"
        ) {
          if (response.status === 200 || response.status === 206) stats.hits++;

          if (response.status === 404) stats.misses++;
        }

        if (request.method === "PUT" && response.ok) stats.uploads++;
        const outgoing = new Headers(response.headers);

        for (const name of [
          "set-cookie",
          "location",
          "connection",
          "keep-alive",
          "transfer-encoding",
          "proxy-authenticate",
        ])
          outgoing.delete(name);

        return new Response(request.method === "HEAD" ? null : response.body, {
          status: response.status,
          headers: outgoing,
        });
      }

      return new Response(null, { status: 502 });
    }),
  };
});

export class CacheProxy extends Context.Service<CacheProxy, Effect.Success<typeof make>>()(
  "@repo/client-core/CacheProxy",
) {}

export const CacheProxyLive = Layer.effect(CacheProxy, make);
