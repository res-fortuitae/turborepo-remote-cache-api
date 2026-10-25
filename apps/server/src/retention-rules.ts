import { Effect, Schema } from "effect";

const Rule = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const Lifecycle = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Struct({ rules: Schema.optional(Schema.Array(Rule)) }),
});
const decodeLifecycle = Schema.decodeUnknownEffect(Lifecycle);

export interface RetentionControlPlane {
  readonly accountId: string;
  readonly bucketName: string;
  readonly jurisdiction?: string;
  readonly token: () => Promise<string>;
  readonly fetch: typeof globalThis.fetch;
}

/** Preserve unrelated rules and fall back to sweeping when the bucket has 1000 rules. */
export const makeRetentionRules = (config: RetentionControlPlane) => ({
  sync: Effect.fn("Retention.syncRule")(function* (
    projectId: string,
    prefix: string,
    days: number,
  ) {
    const token = yield* Effect.tryPromise(config.token);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(config.jurisdiction ? { "cf-r2-jurisdiction": config.jurisdiction } : {}),
    };
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(config.bucketName)}/lifecycle`;
    const response = yield* Effect.tryPromise(() =>
      config.fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) }),
    );
    if (!response.ok) return yield* Effect.fail(new Error("Lifecycle rule read failed"));
    const body = yield* decodeLifecycle(yield* Effect.tryPromise(() => response.json()));
    if (!body.success) return yield* Effect.fail(new Error("Lifecycle rule read rejected"));
    const rules = body.result.rules ?? [];
    const id = `project-${projectId}`;
    const existing = rules.find((rule) => rule.id === id);
    if (!existing && rules.length >= 1000) return false;
    const rule = {
      id,
      enabled: true,
      conditions: { prefix },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: days * 86_400 } },
    };
    if (existing && JSON.stringify(existing) === JSON.stringify(rule)) return true;
    const updated = yield* Effect.tryPromise(() =>
      config.fetch(endpoint, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          rules: [...rules.filter((candidate) => candidate.id !== id), rule],
        }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
    const result = yield* Effect.tryPromise(() => updated.json());
    if (
      !updated.ok ||
      typeof result !== "object" ||
      result === null ||
      !("success" in result) ||
      result.success !== true
    )
      return yield* Effect.fail(new Error("Lifecycle rule update failed"));
    return true;
  }),
});
