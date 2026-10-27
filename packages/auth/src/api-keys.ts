import type { AuditLogService } from "@repo/audit";
import { defaultKeyHasher } from "@better-auth/api-key";
import { schema, type DatabaseDrizzle } from "@repo/db";
import { type AuthSettings, InstancePolicy, tightenPolicy } from "@repo/deploy-config";
import { APIError } from "better-auth/api";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Context, Effect, Option, Schema } from "effect";
import type { BetterAuthInstance } from "./options.ts";
import { readInstancePolicy } from "./instance.ts";
import { hasOrganizationPermission } from "./organization-access.ts";
import type { SecondaryStorageService } from "./secondary-storage.ts";
import { z } from "zod";

import { API_KEY_WARNING } from "./api-key-warning.ts";
export { API_KEY_WARNING } from "./api-key-warning.ts";

/** Application supplies Coordinator operations without making auth depend on coordinator. */
export class ApiKeyEpochs extends Context.Service<
  ApiKeyEpochs,
  {
    readonly read: (scope: string) => Effect.Effect<number, unknown>;
    readonly bump: (scope: string) => Effect.Effect<number, unknown>;
  }
>()("@repo/auth/ApiKeyEpochs") {}

export class ApiKeyBackground extends Context.Service<
  ApiKeyBackground,
  {
    readonly run: (task: Promise<void>) => void;
  }
>()("@repo/auth/ApiKeyBackground") {}

export const VerifiedApiKey = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  projectId: Schema.String,
  scope: Schema.Literals(["read", "read write"]),
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
  orgEpoch: Schema.Number,
  projectEpoch: Schema.Number,
});
export type VerifiedApiKey = typeof VerifiedApiKey.Type;

export class ApiKeyVerificationError extends Schema.TaggedError<ApiKeyVerificationError>()(
  "ApiKeyVerificationError",
  { cause: Schema.Unknown },
) {}

/** Read-only adapter consumed by @repo/credentials; no Better Auth types cross this port. */
export class ApiKeyLookup extends Context.Service<
  ApiKeyLookup,
  {
    readonly verify: (key: string) => Effect.Effect<VerifiedApiKey, ApiKeyVerificationError>;
  }
>()("@repo/auth/ApiKeyLookup") {}

const permissions = z
  .object({
    project: z.array(z.string().min(1)).length(1),
    cache: z.enum(["read", "write"]).array().default(["read"]),
  })
  .strict()
  .refine(
    (p) =>
      (p.cache.length === 1 && p.cache[0] === "read") ||
      (p.cache.length === 2 && new Set(p.cache).size === 2),
    "Scope must be read or read and write",
  );
const createInput = z
  .object({
    organizationId: z.string().min(1),
    name: z.string().min(1).max(100),
    permissions,
    expiresIn: z.number().int().positive().optional(),
  })
  .strict();
const revokeInput = z
  .object({ keyId: z.string().min(1), emergency: z.boolean().default(false) })
  .strict();
const decodePolicy = Schema.decodeUnknownSync(InstancePolicy);
const decodeKey = Schema.decodeUnknownSync(VerifiedApiKey);
const forbidden = () => new APIError("FORBIDDEN");

export const makeApiKeys = (input: {
  db: DatabaseDrizzle;
  auth: BetterAuthInstance;
  config: AuthSettings;
  storage?: SecondaryStorageService;
  epochs?: typeof ApiKeyEpochs.Service;
  background?: typeof ApiKeyBackground.Service;
  audit: AuditLogService;
}) => {
  const { db, auth, config, storage, epochs, background, audit } = input;
  const auditInput = (
    userId: string,
    orgId: string,
    projectId: string,
    id: string,
    action: string,
    emergency = false,
  ) => ({
    scope: "org" as const,
    orgId,
    projectId,
    actor: { type: "user" as const, id: userId, display: userId },
    action,
    target: { type: "apiKey", id },
    outcome: "allow" as const,
    ip: "",
    userAgent: "",
    requestId: crypto.randomUUID(),
    metadata: { emergency },
  });
  const cached = async <A>(key: string, decode: (value: unknown) => A, load: () => Promise<A>) => {
    if (storage) {
      const value = await Effect.runPromise(storage.get(key));
      if (Option.isSome(value)) {
        try {
          return decode(JSON.parse(value.value));
        } catch {
          /* Rebuild corrupt cache. */
        }
      }
    }
    const value = await load();
    if (storage) await Effect.runPromise(storage.set(key, JSON.stringify(value), 60));
    return value;
  };
  const policy = (orgId: string, cache: boolean) => {
    const load = async () => {
      const parent = await readInstancePolicy(db, config);
      const [org] = await db
        .select()
        .from(schema.organizationPolicy)
        .where(eq(schema.organizationPolicy.orgId, orgId));
      return org ? tightenPolicy(parent, decodePolicy(org.settings)) : parent;
    };
    return cache ? cached(`cache-key-policy:${orgId}`, decodePolicy, load) : load();
  };
  const epoch = async (scope: string) => {
    if (!epochs)
      throw new APIError("SERVICE_UNAVAILABLE", { message: "Revocation service unavailable" });
    return Effect.runPromise(epochs.read(scope));
  };
  const permitted = async (userId: string, orgId: string, action: "create" | "revoke") => {
    if (!(await hasOrganizationPermission(db, orgId, userId, "apiKey", action))) throw forbidden();
  };
  const verify = async (key: string): Promise<VerifiedApiKey> => {
    if (!/^tcache_[A-Za-z0-9_-]{32,128}$/.test(key)) throw forbidden();
    const hash = await defaultKeyHasher(key);
    const value = await cached(`cache-key:${hash}`, decodeKey, async () => {
      const [row] = await db
        .select({ key: schema.apikey, stamp: schema.cacheApiKey })
        .from(schema.apikey)
        .innerJoin(schema.cacheApiKey, eq(schema.cacheApiKey.id, schema.apikey.id))
        .where(eq(schema.apikey.key, hash));
      if (!row || !row.key.enabled || !row.key.expiresAt) throw forbidden();
      const p = permissions.parse(JSON.parse(row.key.permissions ?? "null"));
      if (row.key.referenceId !== row.stamp.orgId || p.project[0] !== row.stamp.projectId)
        throw forbidden();
      return {
        id: row.key.id,
        orgId: row.stamp.orgId,
        projectId: row.stamp.projectId,
        scope: p.cache.includes("write") ? ("read write" as const) : ("read" as const),
        issuedAt: row.key.createdAt.getTime(),
        expiresAt: row.key.expiresAt.getTime(),
        orgEpoch: row.stamp.orgEpoch,
        projectEpoch: row.stamp.projectEpoch,
      };
    });
    const currentPolicy = await policy(value.orgId, true);
    if (
      value.expiresAt <= Date.now() ||
      currentPolicy.apiKeys === "disallowed" ||
      Math.floor((value.expiresAt - value.issuedAt) / 1000) >
        currentPolicy.maxApiKeyLifetimeDays * 86400 ||
      value.orgEpoch < (await epoch(`org:${value.orgId}`)) ||
      value.projectEpoch < (await epoch(`project:${value.projectId}`))
    )
      throw forbidden();
    // Conditional D1 update runs at most once per minute per key and location,
    // gated by a KV marker. The marker is a throttle, never an authority for
    // verification or revocation, so sampling failures never reject a valid key.
    // Without a background runner the rare update is awaited inline: Better Auth
    // runs verification in plain promises, outside the Worker's request context.
    if (storage) {
      try {
        if (Option.isNone(await Effect.runPromise(storage.get(`cache-key-used:${value.id}`)))) {
          await Effect.runPromise(storage.set(`cache-key-used:${value.id}`, "1", 60));
          const update = db
            .update(schema.cacheApiKey)
            .set({ lastUsedAt: Date.now() })
            .where(
              and(
                eq(schema.cacheApiKey.id, value.id),
                or(
                  isNull(schema.cacheApiKey.lastUsedAt),
                  lt(schema.cacheApiKey.lastUsedAt, Date.now() - 60000),
                ),
              ),
            )
            .then(() => {});

          if (background) background.run(update);
          else await update;
        }
      } catch (cause) {
        console.error("API key usage sampling failed", cause);
      }
    }
    return value;
  };
  const handle = async (request: Request, userId: string) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") throw new APIError("METHOD_NOT_ALLOWED");
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new APIError("BAD_REQUEST");
    }
    if (path === "/api/auth/cache-keys/create") {
      const parsed = createInput.safeParse(raw);
      if (!parsed.success)
        throw new APIError("BAD_REQUEST", { message: "Invalid project, scope, name or expiry" });
      const body = parsed.data;
      await permitted(userId, body.organizationId, "create");
      const limits = await policy(body.organizationId, false);
      if (limits.apiKeys === "disallowed") throw forbidden();
      const expiresIn = body.expiresIn ?? Math.min(30, limits.maxApiKeyLifetimeDays) * 86400;
      if (expiresIn > Math.min(90, limits.maxApiKeyLifetimeDays) * 86400)
        throw new APIError("BAD_REQUEST");
      const projectId = body.permissions.project[0]!;
      const [project] = await db
        .select()
        .from(schema.project)
        .where(
          and(
            eq(schema.project.id, projectId),
            eq(schema.project.orgId, body.organizationId),
            isNull(schema.project.archivedAt),
          ),
        );
      if (!project) throw forbidden();
      const orgEpoch = await epoch(`org:${body.organizationId}`);
      const projectEpoch = await epoch(`project:${projectId}`);
      // Server-only invocation: caller-supplied plugin controls are never forwarded.
      const created = await auth.api.createApiKey({
        body: {
          userId,
          organizationId: body.organizationId,
          name: body.name,
          permissions: body.permissions,
          expiresIn,
          remaining: null,
        },
      });
      try {
        await Effect.runPromise(
          audit.commit(
            auditInput(userId, body.organizationId, projectId, created.id, "apiKey.create"),
            (db) => [
              db.insert(schema.cacheApiKey).values({
                id: created.id,
                orgId: body.organizationId,
                projectId,
                orgEpoch,
                projectEpoch,
              }),
            ],
          ),
        );
      } catch (cause) {
        await db.delete(schema.apikey).where(eq(schema.apikey.id, created.id));
        throw cause;
      }
      return Response.json(created, {
        headers: { Warning: API_KEY_WARNING, "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/auth/cache-keys/revoke") {
      const parsed = revokeInput.safeParse(raw);
      if (!parsed.success) throw new APIError("BAD_REQUEST");
      const { keyId, emergency } = parsed.data;
      const [row] = await db
        .select({ key: schema.apikey, stamp: schema.cacheApiKey })
        .from(schema.apikey)
        .innerJoin(schema.cacheApiKey, eq(schema.cacheApiKey.id, schema.apikey.id))
        .where(eq(schema.apikey.id, keyId));
      if (!row) throw new APIError("NOT_FOUND");
      await permitted(userId, row.stamp.orgId, "revoke");
      // Bump first: even a subsequent D1/KV failure cannot preserve emergency access.
      if (emergency) {
        if (!epochs) throw new APIError("SERVICE_UNAVAILABLE");
        await Effect.runPromise(epochs.bump(`project:${row.stamp.projectId}`));
      }
      await Effect.runPromise(
        audit.commit(
          auditInput(
            userId,
            row.stamp.orgId,
            row.stamp.projectId,
            keyId,
            "apiKey.revoke",
            emergency,
          ),
          (db) => [
            db.update(schema.apikey).set({ enabled: false }).where(eq(schema.apikey.id, keyId)),
          ],
        ),
      );
      if (storage) await Effect.runPromise(storage.delete(`cache-key:${row.key.key}`));
      return Response.json({ revoked: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (path === "/api/auth/cache-keys/list") {
      const parsed = z.object({ organizationId: z.string() }).strict().safeParse(raw);
      if (!parsed.success) throw new APIError("BAD_REQUEST");
      const body = parsed.data;
      await permitted(userId, body.organizationId, "revoke");
      const rows = await db
        .select({
          id: schema.apikey.id,
          name: schema.apikey.name,
          expiresAt: schema.apikey.expiresAt,
          enabled: schema.apikey.enabled,
          permissions: schema.apikey.permissions,
          lastUsedAt: schema.cacheApiKey.lastUsedAt,
        })
        .from(schema.apikey)
        .innerJoin(schema.cacheApiKey, eq(schema.cacheApiKey.id, schema.apikey.id))
        .where(eq(schema.cacheApiKey.orgId, body.organizationId));
      return Response.json(rows, {
        headers: { Warning: API_KEY_WARNING, "Cache-Control": "no-store" },
      });
    }
    throw new APIError("NOT_FOUND");
  };
  return { handle, verify };
};
