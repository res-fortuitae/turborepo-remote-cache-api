import { NodeFileSystem } from "@effect/platform-node";
import {
  CacheProxyLive,
  ClientCoreLive,
  ClientEnvironment,
  ClientOptions,
  ClientMessages,
  ClientCommandUnavailable,
  DeveloperCredentialsUnavailable,
  ProxyTransport,
  ProxySession,
  type ClientFlags,
} from "@repo/client-core";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

export const actionRuntime = (
  flags: ClientFlags,
  messages: {
    warn: (message: string) => void;
    mask: (value: string) => void;
  },
) =>
  ManagedRuntime.make(
    CacheProxyLive.pipe(
      Layer.provideMerge(ClientCoreLive),
      Layer.provideMerge(
        Layer.mergeAll(
          NodeFileSystem.layer,
          FetchHttpClient.layer,
          ClientCommandUnavailable,
          DeveloperCredentialsUnavailable,
          Layer.succeed(ClientEnvironment, { get: (name) => process.env[name] }),
          Layer.succeed(ClientOptions, { flags }),
          Layer.succeed(ClientMessages, {
            warn: (message) => Effect.sync(() => messages.warn(message)),
            mask: (value) => Effect.sync(() => messages.mask(Redacted.value(value))),
          }),
          Layer.succeed(ProxyTransport, {
            send: (request) =>
              Effect.tryPromise({
                try: () => fetch(request, { redirect: "manual" }),
                catch: () => "upstream unavailable",
              }),
          }),
          Layer.sync(ProxySession, () => ({
            secret: Redacted.make(crypto.randomUUID() + crypto.randomUUID()),
          })),
        ),
      ),
    ),
  );
