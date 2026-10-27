import { api } from "./api.ts";

/** Org-owned API keys: the less secure fallback for CI without OIDC (docs/api-keys.md). */
export interface CacheKey {
  readonly id: string;
  readonly name: string | null;
  readonly expiresAt: string | null;
  readonly enabled: boolean;
  readonly permissions: string | Readonly<Record<string, ReadonlyArray<string>>> | null;
  readonly lastUsedAt: string | number | null;
  readonly createdAt?: string;
}

export interface CreatedCacheKey {
  readonly id: string;
  /** The secret. The server returns it exactly once. */
  readonly key: string;
  readonly name: string | null;
  readonly expiresAt: string | null;
}

export type CacheScope = "read" | "read write";

export const createCacheKey = (input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly name: string;
  readonly scope: CacheScope;
  readonly expiresInDays: number;
}) =>
  api<CreatedCacheKey>("/api/auth/cache-keys/create", {
    method: "POST",
    body: {
      organizationId: input.organizationId,
      name: input.name,
      permissions: {
        project: [input.projectId],
        cache: input.scope === "read" ? ["read"] : ["read", "write"],
      },
      expiresIn: input.expiresInDays * 86400,
    },
  });

export const listCacheKeys = (organizationId: string, signal?: AbortSignal) =>
  api<ReadonlyArray<CacheKey>>("/api/auth/cache-keys/list", {
    method: "POST",
    body: { organizationId },
    signal,
  });

export const revokeCacheKey = (keyId: string, emergency = false) =>
  api<{ readonly revoked: true }>("/api/auth/cache-keys/revoke", {
    method: "POST",
    body: { keyId, emergency },
  });

/** Better Auth stores permissions as JSON text; older rows may already be parsed. */
export const keyPermissions = (key: Pick<CacheKey, "permissions">) => {
  let value: unknown = key.permissions;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const record = (value ?? {}) as Record<string, unknown>;
  const list = (name: string) =>
    Array.isArray(record[name]) ? record[name].filter((item) => typeof item === "string") : [];

  return { projects: list("project"), cache: list("cache") };
};
