import { createServer } from "node:http";
import { once } from "node:events";
import { CacheProxy, TokenCache, ProxySession } from "@repo/client-core";
import { Effect, Redacted } from "effect";
import { actionRuntime } from "./runtime.ts";

const send = (message: object) => {
  if (process.connected) process.send?.(message, () => undefined);
};

const main = async () => {
  const runtime = actionRuntime(
    {
      api: process.env.INPUT_API,
      team: process.env.INPUT_TEAM,
      project: process.env.INPUT_PROJECT,
      strict: true,
      boundTokens: true,
    },
    {
      warn: () => undefined,
      mask: (value) => {
        send({ type: "mask", value });
      },
    },
  );

  let timer: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;

    if (timer) clearInterval(timer);
    server?.closeAllConnections();
    server?.close();
    await runtime.dispose();
    process.exitCode = 0;
  };

  process.on("SIGTERM", () => {
    void stop();
  });
  process.on("SIGINT", () => {
    void stop();
  });

  try {
    const credential = await runtime.runPromise(Effect.flatMap(TokenCache, (cache) => cache.get));

    if (!credential) throw new Error("credential unavailable");
    const proxy = await runtime.runPromise(CacheProxy);
    const session = await runtime.runPromise(ProxySession);
    const secret = Redacted.value(session.secret);
    server = createServer(async (incoming, outgoing) => {
      try {
        const headers = new Headers();

        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(",") : value);
        }

        if (
          incoming.url === "/_tcache/stop" &&
          incoming.method === "POST" &&
          headers.get("authorization") === `Bearer ${secret}`
        ) {
          outgoing.writeHead(200, { "content-type": "application/json" });
          outgoing.end(JSON.stringify(await runtime.runPromise(proxy.stats)));
          setTimeout(() => {
            void stop();
          }, 25);

          return;
        }

        const abort = new AbortController();
        incoming.once("aborted", () => abort.abort());
        outgoing.once("close", () => {
          if (!outgoing.writableFinished) abort.abort();
        });

        const iterator = incoming[Symbol.asyncIterator]();

        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next: IteratorResult<Uint8Array, undefined> = await iterator.next();

            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel() {
            incoming.destroy();
          },
        });

        const init: RequestInit & { duplex: "half" } = {
          method: incoming.method ?? "GET",
          headers,
          duplex: "half",
          signal: abort.signal,
          body: ["GET", "HEAD"].includes(incoming.method ?? "GET") ? undefined : body,
        };

        const response = await runtime.runPromise(
          proxy.handle(new Request(`http://127.0.0.1${incoming.url}`, init)),
          { signal: abort.signal },
        );

        // Node fetch decodes content encodings. Let Node frame the decoded stream correctly.
        const responseHeaders = new Headers(response.headers);

        if (responseHeaders.has("content-encoding")) {
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }

        outgoing.writeHead(response.status, Object.fromEntries(responseHeaders));

        if (response.body === null) outgoing.end();
        else {
          const reader = response.body.getReader();

          try {
            for (;;) {
              const chunk = await reader.read();

              if (chunk.done) break;

              if (!outgoing.write(chunk.value))
                await once(outgoing, "drain", { signal: abort.signal });
            }

            outgoing.end();
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        }
      } catch {
        if (!outgoing.headersSent) {
          outgoing.writeHead(502);
          outgoing.end();
        } else outgoing.destroy();
      }
    });
    server.requestTimeout = 0;
    server.timeout = 0;
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (address === null || typeof address === "string") throw new Error("listener unavailable");
    let refreshing = false;
    timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runtime
        .runPromise(Effect.flatMap(TokenCache, (cache) => cache.get))
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    }, 1000);
    send({
      type: "ready",
      environment: {
        TURBO_API: `http://127.0.0.1:${address.port}`,
        TURBO_TEAM: credential.team,
        TURBO_TOKEN: secret,
        ...(credential.source !== "apiKey" && credential.signatureKey !== undefined
          ? { TURBO_REMOTE_CACHE_SIGNATURE_KEY: Redacted.value(credential.signatureKey) }
          : {}),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error && "reason" in error
        ? error.message
        : "Unable to start cache proxy. Check API/team/project configuration and id-token: write permissions; fork PR identities may be restricted.";

    send({ type: "failure", message });
    await stop();
    process.exitCode = 1;
  }
};

void main().catch(() => {
  process.exitCode = 1;
});
