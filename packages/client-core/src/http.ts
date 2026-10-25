import { Effect, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ClientAuthError } from "./config.ts";

export const invalidResponse = () =>
  new ClientAuthError({
    reason: "invalid_response",
    message:
      "Identity or cache server returned an invalid response. Check the server URL and provider configuration.",
  });

export const readText = Effect.fn("Client.readText")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  let size = 0;
  const decoder = new TextDecoder();

  const text = yield* Stream.runFoldEffect(
    response.stream,
    () => "",
    (text, chunk) => {
      size += chunk.byteLength;

      return size > 65_536
        ? Effect.fail(invalidResponse())
        : Effect.succeed(text + decoder.decode(chunk, { stream: true }));
    },
  ).pipe(Effect.mapError(invalidResponse));

  return text + decoder.decode();
});

/** Generated schema clients also need an actual streaming byte limit with FetchHttpClient. */
export const boundedClient = (client: HttpClient.HttpClient) =>
  HttpClient.transformResponse(client, (effect) =>
    Effect.flatMap(effect, (response) =>
      Effect.gen(function* () {
        const text = yield* readText(response);

        return yield* Effect.try({
          try: () =>
            HttpClientResponse.fromWeb(
              response.request,
              new Response(text, { status: response.status, headers: response.headers }),
            ),
          catch: invalidResponse,
        });
      }),
    ),
  );
