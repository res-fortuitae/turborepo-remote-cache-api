/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun boundary for policy integration tests. */
import { expect, test } from "bun:test";
import { Database, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Authorization, type ProjectAction } from "./index.ts";
import { AuthorizationTest } from "./testing.ts";

const now = new Date("2026-01-01T00:00:00Z");
const expiresAt = new Date("2099-01-01T00:00:00Z");
const principal = { userId: "u", sessionId: "s" };
const actions: readonly ProjectAction[] = ["create", "read", "update", "delete"];

test.each(["owner", "admin", "member", "auditor", "custom"])(
  "organization role %s resolves through current statements",
  (role) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const authz = yield* Authorization;
        yield* database.batch((db) => [
          db.insert(schema.user).values({
            id: "u",
            name: "User",
            email: "u@example.com",
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(schema.session).values({
            id: "s",
            userId: "u",
            token: "token",
            expiresAt,
            createdAt: now,
            updatedAt: now,
          }),
          db
            .insert(schema.organization)
            .values({ id: "org", slug: "org", name: "Org", createdAt: now }),
          db
            .insert(schema.member)
            .values({ id: "m", userId: "u", organizationId: "org", role, createdAt: now }),
          db.insert(schema.organizationRole).values({
            id: "r",
            organizationId: "org",
            role: "custom",
            permission: JSON.stringify({ project: ["read"] }),
            createdAt: now,
          }),
        ]);

        for (const action of actions) {
          expect((yield* authz.can(principal, action, { orgId: "org" })).allowed).toBe(
            role === "owner" || role === "admin" || (role === "custom" && action === "read"),
          );
          expect((yield* authz.can(principal, action, { orgId: "another-org" })).allowed).toBe(
            false,
          );
        }

        yield* database.query("test.demote", (db) =>
          db.update(schema.member).set({ role: "member" }).where(eq(schema.member.id, "m")),
        );
        expect((yield* authz.can(principal, "read", { orgId: "org" })).allowed).toBe(false);
      }).pipe(Effect.provide(AuthorizationTest)),
    ),
);

test.each(["banned", "expired", "impersonated", "different-session"])(
  "%s sessions cannot manage projects",
  (state) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const authz = yield* Authorization;
        yield* database.batch((db) => [
          db.insert(schema.user).values({
            id: "u",
            name: "User",
            email: "u@example.com",
            banned: state === "banned",
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(schema.session).values({
            id: "s",
            userId: "u",
            token: "token",
            expiresAt: state === "expired" ? now : expiresAt,
            impersonatedBy: state === "impersonated" ? "admin" : null,
            createdAt: now,
            updatedAt: now,
          }),
          db
            .insert(schema.organization)
            .values({ id: "org", slug: "org", name: "Org", createdAt: now }),
          db
            .insert(schema.member)
            .values({ id: "m", userId: "u", organizationId: "org", role: "owner", createdAt: now }),
        ]);

        for (const action of actions)
          expect(
            (yield* authz.can(
              { ...principal, sessionId: state === "different-session" ? "other" : "s" },
              action,
              { orgId: "org" },
            )).allowed,
          ).toBe(false);
      }).pipe(Effect.provide(AuthorizationTest)),
    ),
);

test("request snapshots memoize decisions without persisting permissions into the next request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database;
      const authz = yield* Authorization;
      yield* database.batch((db) => [
        db.insert(schema.user).values({
          id: "u",
          name: "User",
          email: "u@example.com",
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(schema.session).values({
          id: "s",
          userId: "u",
          token: "token",
          expiresAt,
          createdAt: now,
          updatedAt: now,
        }),
        db
          .insert(schema.organization)
          .values({ id: "org", slug: "org", name: "Org", createdAt: now }),
        db
          .insert(schema.member)
          .values({ id: "m", userId: "u", organizationId: "org", role: "owner", createdAt: now }),
      ]);
      const first = yield* authz.forRequest;
      expect((yield* first.can(principal, "read", { orgId: "org" })).allowed).toBe(true);
      yield* database.query("test.revoke", (db) =>
        db.delete(schema.member).where(eq(schema.member.id, "m")),
      );
      expect((yield* first.can(principal, "read", { orgId: "org" })).allowed).toBe(true);
      const next = yield* authz.forRequest;
      expect((yield* next.can(principal, "read", { orgId: "org" })).allowed).toBe(false);
      const denied = yield* Effect.result(next.require(principal, "read", { orgId: "org" }));
      expect(denied._tag).toBe("Failure");
    }).pipe(Effect.provide(AuthorizationTest)),
  ));
