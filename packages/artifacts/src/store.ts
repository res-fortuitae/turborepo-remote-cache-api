import { Context, Effect, Layer, Schema, Stream } from "effect";

export class ArtifactStorageError extends Schema.TaggedError<ArtifactStorageError>()(
  "ArtifactStorageError",
  { cause: Schema.Unknown },
) {}

export interface ArtifactMetadata {
  uploadedAt?: string;
  credentialType?: string;
  credentialId?: string;
  userId?: string;
  provider?: string;
  repositoryId?: string;
  ref?: string;
  jobWorkflowRef?: string;
  commitSha?: string;
  runId?: string;
  duration?: string;
  tag?: string;
  sha?: string;
  dirtyHash?: string;
}

export interface StoredArtifact {
  readonly size: number;
  readonly customMetadata?: ArtifactMetadata | undefined;
}

export interface StoredArtifactBody extends StoredArtifact {
  readonly body: Stream.Stream<Uint8Array, unknown>;
  readonly readable?: ReadableStream<Uint8Array> | undefined;
}

export interface ArtifactPutOptions {
  contentLength: number;
  httpMetadata: { contentType: string };
  customMetadata: Record<string, string>;
}

/** The host supplies a binding, never a global bucket. */
export interface ArtifactBucket<R = never> {
  delete(keys: string[]): Effect.Effect<void, unknown, R>;
  head(key: string): Effect.Effect<StoredArtifact | null, unknown, R>;
  get(key: string): Effect.Effect<StoredArtifactBody | null, unknown, R>;
  put<Err>(
    key: string,
    value: Stream.Stream<Uint8Array, Err>,
    options: ArtifactPutOptions,
  ): Effect.Effect<unknown, unknown, R>;
}

export class R2Bucket extends Context.Service<R2Bucket, ArtifactBucket>()(
  "@repo/artifacts/R2Bucket",
) {}

export class ArtifactStore extends Context.Service<
  ArtifactStore,
  {
    readonly head: (
      prefix: string,
      hash: string,
    ) => Effect.Effect<StoredArtifact | null, ArtifactStorageError>;
    readonly get: (
      prefix: string,
      hash: string,
    ) => Effect.Effect<StoredArtifactBody | null, ArtifactStorageError>;
    readonly put: <E>(
      prefix: string,
      hash: string,
      body: Stream.Stream<Uint8Array, E>,
      options: ArtifactPutOptions,
    ) => Effect.Effect<unknown, ArtifactStorageError>;
    readonly remove: (prefix: string, hash: string) => Effect.Effect<void, ArtifactStorageError>;
  }
>()("@repo/artifacts/ArtifactStore") {}

export const ArtifactStoreLive = Layer.effect(
  ArtifactStore,
  Effect.gen(function* () {
    const bucket = yield* R2Bucket;

    const storage = <A>(effect: Effect.Effect<A, unknown>) =>
      Effect.mapError(effect, (cause) => new ArtifactStorageError({ cause }));

    return {
      head: (prefix, hash) => storage(bucket.head(`${prefix}/${hash}`)),
      get: (prefix, hash) => storage(bucket.get(`${prefix}/${hash}`)),
      put: (prefix, hash, body, options) => storage(bucket.put(`${prefix}/${hash}`, body, options)),
      remove: (prefix, hash) => storage(bucket.delete([`${prefix}/${hash}`])),
    } satisfies typeof ArtifactStore.Service;
  }),
);

/** Fresh in-memory bytes for every build, including real streamed bodies. */
export const ArtifactStoreTest = Layer.sync(ArtifactStore, () => {
  const objects = new Map<string, StoredArtifact & { bytes: Uint8Array }>();

  return {
    head: (prefix, hash) => Effect.sync(() => objects.get(`${prefix}/${hash}`) ?? null),
    get: (prefix, hash) =>
      Effect.sync(() => {
        const object = objects.get(`${prefix}/${hash}`);

        return object
          ? {
              ...object,
              body: Stream.make(object.bytes),
              readable: new ReadableStream({
                start(controller) {
                  controller.enqueue(object.bytes);
                  controller.close();
                },
              }),
            }
          : null;
      }),
    put: (prefix, hash, body, options) =>
      Stream.runCollect(body).pipe(
        Effect.map((chunks) => {
          const size = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
          const bytes = new Uint8Array(size);
          let offset = 0;

          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }

          objects.set(`${prefix}/${hash}`, {
            bytes,
            size,
            customMetadata: options.customMetadata,
          });
        }),
        Effect.mapError((cause) => new ArtifactStorageError({ cause })),
      ),
    remove: (prefix, hash) =>
      Effect.sync(() => {
        objects.delete(`${prefix}/${hash}`);
      }),
  } satisfies typeof ArtifactStore.Service;
});
