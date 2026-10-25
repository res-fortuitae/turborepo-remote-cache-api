import { Database, schema } from "@repo/db";
import { AuthConfig } from "@repo/deploy-config";
import { Alerts } from "@repo/mailer";
import { and, asc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { Clock, Effect } from "effect";

/** Daily owner digest; key IDs and names only, never hashes or secrets. */
export const apiKeyDigestJob = Effect.gen(function* () {
  const database = yield* Database;
  const alerts = yield* Alerts;
  const config = yield* AuthConfig;
  const now = yield* Clock.currentTimeMillis;
  let cursor = "";
  while (true) {
    const rows = yield* database.query("ApiKeyDigest.page", (db) =>
      db
        .select({
          id: schema.apikey.id,
          name: schema.apikey.name,
          expiresAt: schema.apikey.expiresAt,
          createdAt: schema.apikey.createdAt,
          orgId: schema.cacheApiKey.orgId,
          lastUsedAt: schema.cacheApiKey.lastUsedAt,
        })
        .from(schema.apikey)
        .innerJoin(schema.cacheApiKey, eq(schema.cacheApiKey.id, schema.apikey.id))
        .where(
          and(
            gt(schema.apikey.id, cursor),
            eq(schema.apikey.enabled, true),
            gt(schema.apikey.expiresAt, new Date(now)),
            or(
              lt(schema.apikey.expiresAt, new Date(now + 7 * 86400000)),
              lt(schema.cacheApiKey.lastUsedAt, now - 14 * 86400000),
              and(
                isNull(schema.cacheApiKey.lastUsedAt),
                lt(schema.apikey.createdAt, new Date(now - 14 * 86400000)),
              ),
            ),
          ),
        )
        .orderBy(asc(schema.apikey.id))
        .limit(100),
    );
    if (!rows.length) break;
    const orgs = new Map<string, typeof rows>();
    for (const row of rows) orgs.set(row.orgId, [...(orgs.get(row.orgId) ?? []), row]);
    for (const [orgId, keys] of orgs) {
      const owners = yield* database.query("ApiKeyDigest.owners", (db) =>
        db
          .select({ user: schema.user, role: schema.member.role })
          .from(schema.member)
          .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
          .where(eq(schema.member.organizationId, orgId)),
      );
      for (const owner of owners) {
        if (
          !owner.role
            .split(",")
            .map((role) => role.trim())
            .includes("owner")
        )
          continue;
        yield* alerts.notify({
          id: `api-key-digest:${Math.floor(now / 86400000)}:${orgId}:${owner.user.id}:${cursor}`,
          userId: owner.user.id,
          to: owner.user.email,
          kind: "api-key-expiring",
          detail:
            `Less secure API keys in organization ${orgId}. Prefer OIDC; rotate or revoke these keys:\n` +
            keys
              .map(
                (key) =>
                  `${key.name ?? key.id} (${key.id}): expires ${key.expiresAt?.toISOString()}; ${key.lastUsedAt === null ? "never used" : `last used ${new Date(key.lastUsedAt).toISOString()}`}`,
              )
              .join("\n"),
          consoleURL: `${config.baseURL ?? ""}/#credentials`,
        });
      }
    }
    cursor = rows.at(-1)!.id;
  }
});
