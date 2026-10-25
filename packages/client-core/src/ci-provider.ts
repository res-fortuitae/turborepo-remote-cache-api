import { CiProvider as ProviderSchema } from "@repo/api-spec";
import { Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ClientAuthError, ClientConfig, ClientEnvironment, ClientMessages } from "./config.ts";
import { readText } from "./http.ts";
import { readFileText } from "./files.ts";

type Provider = typeof ProviderSchema.Type;

/** CLI/Action supplies command execution without a shell or a Node dependency here. */
export class ClientCommand extends Context.Service<
  ClientCommand,
  {
    readonly run: (
      executable: string,
      args: readonly string[],
    ) => Effect.Effect<string, ClientAuthError>;
  }
>()("@repo/client-core/ClientCommand") {}

export const ClientCommandUnavailable = Layer.succeed(ClientCommand, {
  run: () =>
    Effect.fail(
      new ClientAuthError({
        reason: "provider",
        message:
          "This CI provider requires an injected command adapter (buildkite-agent or circleci).",
      }),
    ),
});

const missing = (message: string) => new ClientAuthError({ reason: "missing_token", message });
const Token = Schema.NonEmptyString.check(Schema.isMaxLength(16_384));
const decodeToken = Schema.decodeUnknownEffect(Token);
const ProviderResponse = Schema.fromJsonString(Schema.Struct({ value: Token }));

const decodeProvider = Schema.decodeUnknownEffect(ProviderSchema);

const decodeVercelResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ token: Token })),
);

const decodeProviderResponse = Schema.decodeUnknownEffect(ProviderResponse);

const make = Effect.gen(function* () {
  const env = yield* ClientEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const command = yield* ClientCommand;
  const config = yield* ClientConfig;
  const messages = yield* ClientMessages;

  const detect = Effect.gen(function* (): Effect.fn.Return<Provider | undefined, ClientAuthError> {
    const explicit = env.get("TCACHE_CI_PROVIDER");

    if (explicit !== undefined)
      return yield* decodeProvider(explicit).pipe(
        Effect.mapError(
          () =>
            new ClientAuthError({
              reason: "configuration",
              message: "TCACHE_CI_PROVIDER must name a supported provider.",
            }),
        ),
      );

    if (env.get("GITHUB_ACTIONS") === "true") return "github";

    if (env.get("VERCEL") === "1" || env.header?.("x-vercel-oidc-token")) return "vercel";

    if (env.get("GITLAB_CI") === "true" || env.get("CACHE_ID_TOKEN")) return "gitlab";

    if (env.get("CIRCLECI") === "true" || env.get("CIRCLE_OIDC_TOKEN_V2")) return "circleci";

    if (env.get("BUILDKITE") === "true") return "buildkite";

    if (env.get("BITBUCKET_STEP_UUID") || env.get("BITBUCKET_STEP_OIDC_TOKEN")) return "bitbucket";

    if (env.get("AWS_WEB_IDENTITY_TOKEN_FILE")) return "aws-eks";

    if (env.get("AZURE_FEDERATED_TOKEN_FILE")) return "azure";

    if (env.get("K_SERVICE") || env.get("GCE_METADATA_HOST")) return "google";

    if (env.get("TCACHE_OIDC_TOKEN_FILE") || env.get("TCACHE_ID_TOKEN")) return "custom";

    return undefined;
  });

  const file = Effect.fn("CiProvider.file")(function* (path: string) {
    return yield* readFileText(fs, path).pipe(
      Effect.map((text) => text.trim()),
      Effect.mapError(() =>
        missing(
          "OIDC token file is unavailable or exceeds 16 KiB. Check the projected token path and permissions.",
        ),
      ),
    );
  });

  const fetchToken = Effect.fn("CiProvider.fetchToken")(function* () {
    const provider = yield* detect;

    if (provider === undefined)
      return yield* missing(
        "No CI OIDC provider detected. Configure CI identity or use tcache login / TCACHE_API_KEY.",
      );

    if (provider === "github") {
      const raw = env.get("ACTIONS_ID_TOKEN_REQUEST_URL");
      const credential = env.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN");

      if (!raw || !credential)
        return yield* new ClientAuthError({
          reason: "permission",
          message:
            "GitHub OIDC is unavailable. Grant permissions: id-token: write. Fork pull requests may have restricted permissions.",
        });

      const url = yield* Effect.try({
        try: () => new URL(raw),
        catch: () => missing("Invalid GitHub OIDC request URL."),
      });

      if (url.protocol !== "https:" || url.username || url.password)
        return yield* missing("GitHub OIDC request URL must use HTTPS without credentials.");
      url.searchParams.set("audience", config.audience);
      yield* messages.mask(Redacted.make(credential));

      const response = yield* http.get(url.href, {
        headers: { authorization: `Bearer ${credential}` },
      });

      if (response.status !== 200)
        return yield* new ClientAuthError({
          reason: "permission",
          message:
            "GitHub refused the ID token. Check id-token: write and fork pull-request permissions.",
        });

      return (yield* decodeProviderResponse(yield* readText(response))).value;
    }

    if (provider === "vercel") {
      const header = env.header?.("x-vercel-oidc-token");
      const path = env.get("VERCEL_OIDC_TOKEN_FILE");

      const source = yield* decodeToken(
        (header || (path ? yield* file(path) : env.get("VERCEL_OIDC_TOKEN")))?.trim(),
      );

      yield* messages.mask(Redacted.make(source));

      // Fixed trusted endpoint, fresh ID per attempt; never cache a single-use assertion.
      const request = HttpClientRequest.post("https://oidc.vercel.com/~token").pipe(
        HttpClientRequest.bodyJsonUnsafe({
          token: source,
          aud: config.audience,
          jti: crypto.randomUUID(),
        }),
      );

      const response = yield* http.execute(request);

      if (response.status !== 200)
        return yield* missing(
          "Vercel audience exchange failed. Check OIDC federation and deployment token expiry.",
        );

      return (yield* decodeVercelResponse(yield* readText(response))).token;
    }

    if (provider === "gitlab") return env.get("CACHE_ID_TOKEN");

    if (provider === "circleci")
      return yield* command.run("circleci", [
        "run",
        "oidc",
        "get",
        "--claims",
        JSON.stringify({ aud: config.audience }),
        "--v2",
      ]);

    if (provider === "bitbucket") return env.get("BITBUCKET_STEP_OIDC_TOKEN");

    if (provider === "buildkite")
      return yield* command.run("buildkite-agent", [
        "oidc",
        "request-token",
        "--audience",
        config.audience,
      ]);

    if (provider === "google") {
      // No metadata probing outside an explicitly detected/selected Google environment.
      const url = new URL(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
      );

      url.searchParams.set("audience", config.audience);
      url.searchParams.set("format", "full");
      const response = yield* http.get(url.href, { headers: { "Metadata-Flavor": "Google" } });

      if (response.status !== 200)
        return yield* missing(
          "Google metadata identity token is unavailable. Check the service account and metadata access.",
        );

      return yield* readText(response);
    }

    const path =
      env.get("TCACHE_OIDC_TOKEN_FILE") ??
      env.get(
        provider === "aws-eks" ? "AWS_WEB_IDENTITY_TOKEN_FILE" : "AZURE_FEDERATED_TOKEN_FILE",
      );

    return path ? yield* file(path) : env.get("TCACHE_ID_TOKEN");
  });

  return {
    detect,
    token: fetchToken().pipe(
      Effect.flatMap((value) => decodeToken(value?.trim())),
      Effect.map(Redacted.make),
      Effect.tap(messages.mask),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
      }),
      Effect.timeout("10 seconds"),
      Effect.mapError((error) =>
        error instanceof ClientAuthError
          ? error
          : missing(
              "CI ID token is unavailable or invalid. Check provider token configuration and audience.",
            ),
      ),
    ),
  };
});

export class CiProvider extends Context.Service<CiProvider, Effect.Success<typeof make>>()(
  "@repo/client-core/CiProvider",
) {}

export const CiProviderLive = Layer.effect(CiProvider, make);
