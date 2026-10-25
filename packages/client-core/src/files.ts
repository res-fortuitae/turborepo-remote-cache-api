import { Effect, type FileSystem, Stream } from "effect";
import { ClientAuthError } from "./errors.ts";

/** Stop while streaming, even if a file grows after a stat call. */
export const readFileText = Effect.fn("Client.readFileText")(function* (
  fs: FileSystem.FileSystem,
  path: string,
) {
  const decoder = new TextDecoder();
  let size = 0;

  const text = yield* Stream.runFoldEffect(
    fs.stream(path, { bytesToRead: 16_385 }),
    () => "",
    (text, chunk) => {
      size += chunk.byteLength;

      return size > 16_384
        ? Effect.fail(
            new ClientAuthError({
              reason: "configuration",
              message: "Client credential/config file exceeds 16 KiB.",
            }),
          )
        : Effect.succeed(text + decoder.decode(chunk, { stream: true }));
    },
  );

  return text + decoder.decode();
});
