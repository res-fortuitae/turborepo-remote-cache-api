/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- HTTP and persistence boundary integration. */
import { test, expect } from "bun:test";
import {
  IncidentPurge,
  IncidentPurgeLive,
  PurgeInventory,
  ArtifactPurger,
  PurgeJobs,
} from "@repo/artifacts";
import { AuditLogD1Only } from "@repo/audit";
import { AuthTest } from "@repo/auth/testing";
import { AuthorizationDatabaseLive } from "@repo/authz";
import { Database, ProjectRepoLive, InstanceSettingsRepoLive, schema } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { AuthorizationAuditLive } from "@repo/projects";
import { CanonicalOrigin } from "@repo/deploy-config";
import { Effect, Layer } from "effect";
import * as Request from "effect/http/HttpServerRequest";
import * as Response from "effect/http/HttpServerResponse";
import { PurgeJobsLive } from "../src/purge-jobs.ts";
import { purgeRoute } from "../src/purge-route.ts";

const jobs = PurgeJobsLive.pipe(Layer.provide(AuditLogD1Only), Layer.provideMerge(DatabaseTest));
const incident = IncidentPurgeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      jobs,
      Layer.succeed(PurgeInventory, {
        list: () => Effect.succeed({ objects: [] }),
        head: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
      Layer.succeed(ArtifactPurger, {
        invalidate: () => Effect.succeed(1),
        remove: () => Effect.void,
      }),
    ),
  ),
);
const layer = Layer.mergeAll(
  incident,
  jobs,
  AuthTest,
  ProjectRepoLive.pipe(Layer.provide(DatabaseTest)),
  InstanceSettingsRepoLive.pipe(Layer.provide(DatabaseTest)),
  AuthorizationDatabaseLive.pipe(
    Layer.provide(AuthorizationAuditLive.pipe(Layer.provide(AuditLogD1Only))),
    Layer.provide(DatabaseTest),
  ),
);

test("purge routes require a live session, origin and project administration; jobs and audit survive service rebuilds", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const now = new Date();
      yield* db.batch((q) => [
        q.insert(schema.user).values({
          id: "u",
          name: "Admin",
          email: "u@example.com",
          createdAt: now,
          updatedAt: now,
        }),
        q.insert(schema.session).values({
          id: "s",
          userId: "u",
          token: "token",
          expiresAt: new Date("2099-01-01"),
          createdAt: now,
          updatedAt: now,
        }),
        q.insert(schema.organization).values({ id: "o", name: "Org", slug: "org", createdAt: now }),
        q
          .insert(schema.member)
          .values({ id: "m", organizationId: "o", userId: "u", role: "owner", createdAt: now }),
        q.insert(schema.project).values({
          id: "p",
          orgId: "o",
          name: "Project",
          slug: "project",
          createdAt: now.getTime(),
        }),
      ]);
      const key = yield* Effect.promise(() =>
        crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("auth-test-secret-0123456789abcdef0123456789"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      );
      const signature = yield* Effect.promise(() =>
        crypto.subtle.sign("HMAC", key, new TextEncoder().encode("token")),
      );
      const cookie = `better-auth.session_token=${encodeURIComponent(`token.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
      const serve = (
        path: string,
        method: string,
        cookieValue = cookie,
        origin = "http://localhost",
        body = "{}",
      ) =>
        purgeRoute.pipe(
          Effect.provideService(
            Request.HttpServerRequest,
            Request.fromWeb(
              new globalThis.Request(`http://localhost${path}`, {
                method,
                headers: { cookie: cookieValue, origin, "content-type": "application/json" },
                ...(method === "POST" ? { body } : {}),
              }),
            ),
          ),
          Effect.provideService(CanonicalOrigin, "http://localhost"),
          Effect.map(Response.toWeb),
        );
      expect((yield* serve("/projects/p/purges", "POST", "")).status).toBe(401);
      expect((yield* serve("/projects/p/purges", "POST", cookie, "https://evil.test")).status).toBe(
        403,
      );
      const created = yield* serve(
        "/projects/p/purges",
        "POST",
        cookie,
        undefined,
        '{"credentialId":"bad"}',
      );
      expect(created.status).toBe(202);
      const repo = yield* PurgeJobs;
      const ids = yield* repo.pending;
      expect(ids).toHaveLength(1);
      expect(yield* repo.claim(ids[0]!, Date.now())).toBe(true);
      expect(yield* repo.claim(ids[0]!, Date.now())).toBe(false);
      yield* repo.release(ids[0]!);
      const purge = yield* IncidentPurge;
      yield* purge.tick;
      const ready = yield* serve(`/projects/p/purges/${ids[0]}`, "GET");
      expect(ready.status).toBe(200);
      expect(yield* Effect.promise(() => ready.json())).toMatchObject({
        state: "ready",
        count: 0,
        bytes: 0,
      });
      expect((yield* serve(`/projects/p/purges/${ids[0]}/confirm`, "POST")).status).toBe(202);
      yield* purge.tick;
      expect((yield* repo.get(ids[0]!))?.state).toBe("complete");
      const audit = yield* db.query("test.audit", (q) => q.select().from(schema.auditEvent));
      expect(audit.length).toBeGreaterThanOrEqual(5);
      // Fresh authorization reads after dropping the organization role reject the same session.
      yield* db.query("test.demote", (q) => q.update(schema.member).set({ role: "member" }));
      expect((yield* serve(`/projects/p/purges/${ids[0]}`, "GET")).status).toBe(403);
    }).pipe(Effect.provide(layer), Effect.scoped),
  ));
