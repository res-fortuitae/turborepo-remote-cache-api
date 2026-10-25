import { Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect";

import { ClientAuthError } from "./errors.ts";
import { readFileText } from "./files.ts";

export { ClientAuthError } from "./errors.ts";

/** App-owned environment/header access; this library never reads process globals. */
export class ClientEnvironment extends Context.Service<
  ClientEnvironment,
  {
    readonly get: (name: string) => string | undefined;
    readonly header?: (name: string) => string | undefined;
  }
>()("@repo/client-core/ClientEnvironment") {}

export interface ClientFlags {
  readonly api?: string;
  readonly team?: string;
  readonly project?: string;
  readonly audience?: string;
  readonly strict?: boolean;
  readonly boundTokens?: boolean;
}

export class ClientOptions extends Context.Service<
  ClientOptions,
  {
    readonly flags: ClientFlags;
    readonly configFile?: string;
    /** The host can provide the instance's capability/policy decision. */
    readonly apiKeysAllowed?: boolean;
  }
>()("@repo/client-core/ClientOptions") {}

export const ClientOptionsLive = Layer.succeed(ClientOptions, { flags: {} });

export class ClientMessages extends Context.Service<
  ClientMessages,
  {
    readonly warn: (message: string) => Effect.Effect<void>;
    /** Action adapters implement this with add-mask; no credential enters a log message. */
    readonly mask: (value: Redacted.Redacted<string>) => Effect.Effect<void>;
  }
>()("@repo/client-core/ClientMessages") {}

export const ClientMessagesTest = Layer.succeed(ClientMessages, {
  warn: () => Effect.void,
  mask: () => Effect.void,
});

export interface ResolvedClientConfig {
  readonly api: string;
  readonly audience: string;
  readonly team: string;
  readonly project: string;
  readonly strict: boolean;
  readonly boundTokens: boolean;
  readonly apiKey?: Redacted.Redacted<string>;
  readonly apiKeysAllowed: boolean;
}

export class ClientConfig extends Context.Service<ClientConfig, ResolvedClientConfig>()(
  "@repo/client-core/ClientConfig",
) {}

const LinkedProject = Schema.Struct({
  api: Schema.optional(Schema.NonEmptyString),
  team: Schema.optional(Schema.NonEmptyString),
  project: Schema.optional(Schema.NonEmptyString),
  audience: Schema.optional(Schema.NonEmptyString),
  projectSlug: Schema.optional(Schema.String),
});

const ConfigValues = Schema.Struct({
  api: Schema.NonEmptyString,
  team: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  project: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  audience: Schema.NonEmptyString,
});

const decodeLinkedProject = Schema.decodeUnknownEffect(Schema.fromJsonString(LinkedProject));
const decodeConfig = Schema.decodeUnknownEffect(ConfigValues);

const invalid = () =>
  new ClientAuthError({
    reason: "configuration",
    message:
      "Set TCACHE_API, TCACHE_TEAM and TCACHE_PROJECT, pass flags, or link .turbo-cache.json. API must be HTTPS (HTTP is allowed only on loopback).",
  });

export const ClientConfigLive = Layer.effect(
  ClientConfig,
  Effect.gen(function* () {
    const env = yield* ClientEnvironment;
    const options = yield* ClientOptions;
    const fs = yield* FileSystem.FileSystem;
    const path = options.configFile ?? ".turbo-cache.json";

    const linked = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(path))) return {};

      return yield* decodeLinkedProject(yield* readFileText(fs, path));
    }).pipe(Effect.mapError(invalid));

    const api = options.flags.api ?? env.get("TCACHE_API") ?? linked.api;

    const values = yield* decodeConfig({
      api,
      team: options.flags.team ?? env.get("TCACHE_TEAM") ?? linked.team,
      project: options.flags.project ?? env.get("TCACHE_PROJECT") ?? linked.project,
      audience: options.flags.audience ?? env.get("TCACHE_AUDIENCE") ?? linked.audience ?? api,
    }).pipe(Effect.mapError(invalid));

    const url = yield* Effect.try({ try: () => new URL(values.api), catch: invalid });

    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      return yield* invalid();
    const strict = env.get("TCACHE_STRICT");

    if (
      options.flags.strict === undefined &&
      strict !== undefined &&
      !["true", "false", "1", "0"].includes(strict)
    )
      return yield* invalid();
    const apiKey = env.get("TCACHE_API_KEY");

    return {
      ...values,
      api: url.origin,
      audience: values.audience === values.api ? url.origin : values.audience,
      strict: options.flags.strict ?? (strict === "true" || strict === "1"),
      boundTokens: options.flags.boundTokens ?? false,
      apiKeysAllowed: options.apiKeysAllowed ?? true,
      apiKey: apiKey ? Redacted.make(apiKey) : undefined,
    };
  }),
);
