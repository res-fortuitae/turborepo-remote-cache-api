import { AuditEvent } from "@repo/api-spec";
import { AuditHistory, AuditQueryError, auditHistorySql } from "@repo/audit";
import { Effect, Layer, Redacted, Schema } from "effect";

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    success: Schema.Literal(true),
    result: Schema.Struct({ rows: Schema.Array(Schema.Unknown) }),
  }),
);
const decodeEvent = Schema.decodeUnknownSync(AuditEvent);

/** REST boundary; no SQL string or endpoint can be supplied by an HTTP caller. */
export const basinAuditHistory = (
  accountId: string,
  bucket: string,
  token: Redacted.Redacted<string>,
  request: (url: string, init: RequestInit) => Promise<globalThis.Response> = fetch,
) =>
  Layer.succeed(AuditHistory, {
    read: (selection, limit) =>
      Effect.tryPromise({
        try: async () => {
          if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket))
            throw new Error("Invalid audit warehouse configuration");
          const response = await request(
            `https://api.sql.cloudflarestorage.com/api/v1/accounts/${accountId}/basin-sql/query/${bucket}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Redacted.value(token)}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query: auditHistorySql(selection, limit) }),
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error("Audit history query failed");
          }
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > 8 * 1024 * 1024)
                throw new Error("Audit history page exceeds response limit");
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const result = decode(JSON.parse(new TextDecoder().decode(bytes)));
          if (result.result.rows.length > limit)
            throw new Error("Audit history page exceeds requested limit");
          return result.result.rows.map((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row))
              throw new Error("Invalid audit history row");
            // Iceberg materializes absent optional fields as null.
            return decodeEvent(
              Object.fromEntries(
                Object.entries(row).filter(
                  ([key, value]) =>
                    value !== null || !["orgId", "projectId", "reason"].includes(key),
                ),
              ),
            );
          });
        },
        catch: () => new AuditQueryError({ cause: "Audit history unavailable or invalid" }),
      }),
  });
