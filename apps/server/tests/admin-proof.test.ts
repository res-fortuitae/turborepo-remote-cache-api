/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun owns the test runtime. */
import { expect, test } from "bun:test";
import { Database, InstanceSettingsRepoLive, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { defaultInstancePolicy } from "@repo/deploy-config";
import { Effect, Layer, Result } from "effect";
import { requireAdminProof } from "../src/admin-proof.ts";

for (const role of ["owner", "admin", "org-owner", "org-admin", "project-admin"]) {
  for (const enabled of [false, true]) {
    for (const proof of [false, true]) {
      test(`server management proof: ${role}, policy=${enabled}, proof=${proof}`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const db = yield* Database;
            const now = new Date();
            yield* db.batch((q) => [
              q.insert(schema.user).values({
                id: "u",
                name: "User",
                email: "u@example.com",
                role: role === "owner" || role === "admin" ? role : "member",
                createdAt: now,
                updatedAt: now,
              }),
              q.insert(schema.session).values({
                id: "s",
                userId: "u",
                token: "token",
                expiresAt: new Date(Date.now() + 60_000),
                createdAt: now,
                updatedAt: now,
              }),
              q
                .insert(schema.organization)
                .values({ id: "o", name: "Org", slug: "org", createdAt: now }),
              q.insert(schema.organizationPolicy).values({
                orgId: "o",
                settings: {
                  ...defaultInstancePolicy,
                  allowedEmailDomains: [...defaultInstancePolicy.allowedEmailDomains],
                  allowedGithubOrgs: [...defaultInstancePolicy.allowedGithubOrgs],
                  allowedOidcIssuers: [...defaultInstancePolicy.allowedOidcIssuers],
                  requirePasskeyForAdmins: enabled,
                },
                updatedAt: 1,
              }),
              ...(proof
                ? [
                    q
                      .insert(schema.passkeyProof)
                      .values({ sessionId: "s", userId: "u", verifiedAt: Date.now() }),
                  ]
                : []),
            ]);
            // Deliberately stale caller role: the database must govern the decision.
            const result = yield* Effect.result(
              requireAdminProof("o", { id: "u", role: "member" }, "s"),
            );
            expect(Result.isFailure(result)).toBe(
              enabled && !proof && (role === "owner" || role === "admin"),
            );
          }).pipe(Effect.provide(InstanceSettingsRepoLive.pipe(Layer.provideMerge(DatabaseTest)))),
        ));
    }
  }
}
