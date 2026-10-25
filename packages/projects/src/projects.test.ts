/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Bun executes effects at the test boundary. */
import { expect, test } from "bun:test";
import { AuditLog, AuditLogError } from "@repo/audit";
import { defaultInstancePolicy } from "@repo/deploy-config";
import { Database, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { Clock, Effect, Layer, Result, Schema } from "effect";
import { Project as ProjectResponse, TrustPolicyRequest } from "@repo/api-spec";
import { PolicyGuardrailsLive } from "@repo/oidc";
import { OidcAudience } from "@repo/deploy-config";
import { Projects, ProjectsLive, ProjectLimits, type ProjectActor } from "./index.ts";
import { ProjectsTest } from "./testing.ts";
import { AuthorizationDatabaseLive } from "@repo/authz";
import { AuthConfigTest } from "@repo/auth/testing";
import { ProjectRepoLive } from "@repo/db";

const actor: ProjectActor = {
  userId: "u",
  sessionId: "s",
  display: "User",
  requestId: "request",
  ip: "",
  userAgent: "test",
};

const decodeProject = Schema.decodeUnknownSync(ProjectResponse);
const isString = Schema.is(Schema.String);

const seed = Effect.gen(function* () {
  const db = yield* Database;
  const now = new Date("2026-01-01T00:00:00Z");
  yield* db.batch((db) => [
    db
      .insert(schema.user)
      .values({ id: "u", name: "User", email: "u@example.com", createdAt: now, updatedAt: now }),
    db.insert(schema.session).values({
      id: "s",
      userId: "u",
      token: "token",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(schema.organization).values([
      { id: "a", slug: "org-a", name: "Org A", createdAt: now },
      { id: "b", slug: "org-b", name: "Org B", createdAt: now },
    ]),
    db
      .insert(schema.member)
      .values({ id: "m", userId: "u", organizationId: "a", role: "owner", createdAt: now }),
  ]);
});

const run = <A, E>(program: Effect.Effect<A, E, Projects | Database>) =>
  Effect.runPromise(seed.pipe(Effect.andThen(program), Effect.provide(ProjectsTest)));

test("create, paginate, rename, archive and restore keep a stable project id and audit each mutation", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;

      const created = decodeProject(
        yield* projects.create(actor, "a", {
          slug: "cache",
          name: " Cache ",
          retentionDays: 400,
          maxArtifactBytes: 500_000_000,
        }),
      );

      expect(created).toMatchObject({
        orgId: "a",
        name: "Cache",
        retentionDays: 30,
        maxArtifactBytes: 100_000_000,
        archivedAt: null,
      });
      expect(created.createdAt).toMatch(/Z$/);
      yield* projects.create(actor, "a", { slug: "other", name: "Other" });
      const page = yield* projects.list(actor, "a", { limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();

      const next = yield* projects.list(actor, "a", {
        limit: 1,
        cursor: page.nextCursor ?? undefined,
      });

      expect(next.items).toHaveLength(1);
      expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
      expect(next.nextCursor).toBeNull();

      const updated = yield* projects.update(actor, created.id, {
        slug: "renamed",
        description: "Details",
        archived: true,
      });

      expect(updated.id).toBe(created.id);
      expect(updated.archivedAt).not.toBeNull();
      const repeated = yield* projects.update(actor, created.id, { archived: true });
      expect(repeated.archivedAt).toBe(updated.archivedAt);

      const restored = yield* projects.update(actor, created.id, {
        archived: false,
        description: null,
      });

      expect(restored).toMatchObject({
        id: created.id,
        slug: "renamed",
        archivedAt: null,
        description: null,
      });
      expect(yield* projects.get(actor, created.id)).toEqual(restored);
      const events = yield* db.query("test.events", (db) => db.select().from(schema.auditEvent));
      expect(events.map((row) => row.payload.action)).toEqual([
        "project.create",
        "project.create",
        "project.archive",
        "project.archive",
        "project.restore",
      ]);
      expect(
        events.every((row) => row.orgId === "a" && row.projectId !== null && row.hash !== null),
      ).toBe(true);
    }),
  ));

test("slugs are unique within an org, and conflicts and invalid input leave projects unchanged", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;
      yield* projects.create(actor, "a", { slug: "cache", name: "Cache" });
      const other = yield* projects.create(actor, "a", { slug: "other", name: "Other" });
      expect(
        (yield* Effect.result(projects.create(actor, "a", { slug: "cache", name: "Duplicate" })))
          ._tag,
      ).toBe("Failure");
      const conflict = yield* Effect.result(projects.update(actor, other.id, { slug: "cache" }));
      expect(Result.isFailure(conflict) && conflict.failure._tag).toBe("Conflict");

      for (const input of [
        { slug: "../escape", name: "Name" },
        { slug: "valid", name: "   " },
        { slug: "valid", name: "Name", retentionDays: 0 },
      ]) {
        const invalid = yield* Effect.result(projects.create(actor, "a", input));
        expect(Result.isFailure(invalid) && invalid.failure._tag).toBe("BadRequest");
      }

      expect((yield* projects.get(actor, other.id)).slug).toBe("other");
      yield* db.query("test.member", (db) =>
        db.insert(schema.member).values({
          id: "mb",
          userId: "u",
          organizationId: "b",
          role: "admin",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        }),
      );
      expect((yield* projects.create(actor, "b", { slug: "cache", name: "Cache" })).orgId).toBe(
        "b",
      );
    }),
  ));

test("cross-org access, revoked membership and archived-org writes are denied and audited", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;
      const project = yield* projects.create(actor, "a", { slug: "cache", name: "Cache" });

      for (const operation of [
        projects.list(actor, "b").pipe(Effect.asVoid),
        projects.create(actor, "b", { slug: "x", name: "X" }).pipe(Effect.asVoid),
      ]) {
        const denied = yield* Effect.result(operation);
        expect(Result.isFailure(denied) && denied.failure._tag).toBe("Forbidden");
      }

      yield* db.query("test.archiveOrg", (db) =>
        db.insert(schema.orgLifecycle).values({ orgId: "a", archivedAt: 1 }),
      );
      expect((yield* projects.get(actor, project.id)).id).toBe(project.id);

      const archived = yield* Effect.result(
        projects.update(actor, project.id, { name: "Blocked" }),
      );

      expect(Result.isFailure(archived) && archived.failure._tag).toBe("Forbidden");
      yield* db.query("test.removeMember", (db) =>
        db.delete(schema.member).where(eq(schema.member.id, "m")),
      );
      const removed = yield* Effect.result(projects.get(actor, project.id));
      expect(Result.isFailure(removed) && removed.failure._tag).toBe("Forbidden");
      const events = yield* db.query("test.denials", (db) => db.select().from(schema.auditEvent));
      expect(events.filter((row) => row.payload.outcome === "deny")).toHaveLength(4);
    }),
  ));

test("instance admins require unexpired elevation in the same session and org", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;
      yield* db.query("test.admin", (db) =>
        db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, "u")),
      );
      const denied = yield* Effect.result(projects.list(actor, "b"));
      expect(Result.isFailure(denied) && denied.failure._tag).toBe("Forbidden");
      yield* db.query("test.elevate", (db) =>
        db.insert(schema.orgElevation).values({
          id: "e",
          orgId: "b",
          userId: "u",
          sessionId: "s",
          reason: "Support",
          expiresAt: Date.parse("2099-01-01T00:00:00Z"),
        }),
      );
      const project = yield* projects.create(actor, "b", { slug: "cache", name: "Cache" });
      expect(project.orgId).toBe("b");
      yield* db.query("test.expire", (db) => db.update(schema.orgElevation).set({ expiresAt: 1 }));
      const expired = yield* Effect.result(projects.get(actor, project.id));
      expect(Result.isFailure(expired) && expired.failure._tag).toBe("Forbidden");
    }),
  ));

test("live org policy tightens project limits and passkey step-up gates mutations", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;
      const project = yield* projects.create(actor, "a", { slug: "cache", name: "Cache" });
      yield* db.query("test.policy", (db) =>
        db.insert(schema.organizationPolicy).values({
          orgId: "a",
          settings: {
            ...defaultInstancePolicy,
            retentionDays: 7,
            quotaBytes: 1000,
            allowedEmailDomains: [],
            allowedGithubOrgs: [],
            allowedOidcIssuers: [],
            requirePasskeyForAdmins: true,
          },
          updatedAt: 1,
        }),
      );
      expect(yield* projects.get(actor, project.id)).toMatchObject({
        retentionDays: 7,
        maxArtifactBytes: 1000,
      });
      const denied = yield* Effect.result(projects.update(actor, project.id, { name: "Blocked" }));
      expect(Result.isFailure(denied) && denied.failure._tag).toBe("Forbidden");
      const verifiedAt = yield* Clock.currentTimeMillis;
      yield* db.query("test.passkey", (db) =>
        db.insert(schema.passkeyProof).values({ sessionId: "s", userId: "u", verifiedAt }),
      );
      expect(
        yield* projects.update(actor, project.id, {
          name: "Allowed",
          retentionDays: 300,
          maxArtifactBytes: 100_000,
        }),
      ).toMatchObject({ name: "Allowed", retentionDays: 7, maxArtifactBytes: 1000 });
    }),
  ));

test("an audit insert failure rolls the project mutation back", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;

      // Duplicate audit ids force a real batch failure after the project insert.
      const broken = Layer.fresh(ProjectsLive).pipe(
        Layer.provide(PolicyGuardrailsLive),
        Layer.provide(Layer.succeed(OidcAudience, ["cache"])),
        Layer.provide(Layer.mergeAll(ProjectRepoLive, AuthorizationDatabaseLive)),
        Layer.provide(
          Layer.succeed(AuditLog, {
            record: () =>
              Effect.fail(new AuditLogError({ operation: "test", cause: "unavailable" })),
            commit: (_input, change) =>
              db
                .batch((q) => [
                  q
                    .insert(schema.auditEvent)
                    .values({ id: "duplicate", ts: 1, schemaVersion: 1, payload: {} }),
                  ...change(q),
                  q
                    .insert(schema.auditEvent)
                    .values({ id: "duplicate", ts: 1, schemaVersion: 1, payload: {} }),
                ])
                .pipe(
                  Effect.mapError((cause) => new AuditLogError({ operation: "test", cause })),
                  Effect.andThen(
                    Effect.fail(
                      new AuditLogError({ operation: "test", cause: "Expected batch failure" }),
                    ),
                  ),
                ),
            recordStandalone: () => Effect.die("unused"),
            drainOutbox: () => Effect.succeed(0),
            prune: () => Effect.succeed(0),
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            AuthConfigTest,
            Layer.succeed(ProjectLimits, { retentionDays: 30, maxArtifactBytes: 1000 }),
          ),
        ),
        Layer.provide(Layer.succeed(Database, db)),
      );

      const failed = yield* Effect.result(
        Effect.gen(function* () {
          const projects = yield* Projects;

          return yield* projects.create(actor, "a", {
            slug: "cache",
            name: "Cache",
            github: {
              repository: "org/repo",
              repositoryId: "1",
              repositoryOwnerId: "2",
              defaultBranch: "main",
              audience: "cache",
            },
          });
        }).pipe(Effect.provide(broken)),
      );

      expect(failed._tag).toBe("Failure");
      expect(yield* db.query("test.projects", (db) => db.select().from(schema.project))).toEqual(
        [],
      );
      expect(
        yield* db.query("test.defaultPolicies", (db) => db.select().from(schema.trustPolicy)),
      ).toEqual([]);
      const projects = yield* Projects;
      const project = yield* projects.create(actor, "a", { slug: "cache", name: "Cache" });
      const policy = yield* projects.saveTrustPolicy(actor, project.id, trustInput);

      for (const change of [
        (service: typeof Projects.Service) =>
          service.saveTrustPolicy(actor, project.id, trustInput).pipe(Effect.asVoid),
        (service: typeof Projects.Service) =>
          service
            .saveTrustPolicy(actor, project.id, { ...trustInput, enabled: false }, policy.id)
            .pipe(Effect.asVoid),
        (service: typeof Projects.Service) =>
          service.deleteTrustPolicy(actor, project.id, policy.id),
      ]) {
        const failed = yield* Effect.result(
          Effect.gen(function* () {
            return yield* change(yield* Projects);
          }).pipe(Effect.provide(broken)),
        );
        expect(failed._tag).toBe("Failure");
        expect(yield* projects.listTrustPolicies(actor, project.id)).toEqual([policy]);
      }
    }),
  ));

test("grants combine direct and live same-org teams; member and team removal apply immediately", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;
      const project = yield* projects.create(actor, "a", { slug: "cache", name: "Cache" });
      const now = new Date("2026-01-01T00:00:00Z");
      yield* db.batch((db) => [
        db.insert(schema.user).values({
          id: "dev",
          name: "Dev",
          email: "dev@example.com",
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(schema.session).values({
          id: "dev-s",
          userId: "dev",
          token: "dev-token",
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(schema.member).values({
          id: "dev-m",
          userId: "dev",
          organizationId: "a",
          role: "member",
          createdAt: now,
        }),
        db.insert(schema.team).values([
          { id: "team", name: "Team", organizationId: "a", createdAt: now },
          { id: "foreign", name: "Foreign", organizationId: "b", createdAt: now },
        ]),
        db
          .insert(schema.teamMember)
          .values({ id: "tm", userId: "dev", teamId: "team", createdAt: now }),
      ]);
      const developer = { ...actor, userId: "dev", sessionId: "dev-s" };
      yield* projects.addGrant(actor, project.id, {
        principalType: "user",
        principalId: "dev",
        role: "cache:read",
      });
      expect((yield* projects.get(developer, project.id)).id).toBe(project.id);

      const denied = yield* Effect.result(
        projects.update(developer, project.id, { name: "Blocked" }),
      );

      expect(Result.isFailure(denied) && denied.failure._tag).toBe("Forbidden");
      yield* projects.addGrant(actor, project.id, {
        principalType: "team",
        principalId: "team",
        role: "project:admin",
      });
      expect((yield* projects.update(developer, project.id, { name: "Allowed" })).name).toBe(
        "Allowed",
      );
      expect(yield* projects.listGrants(developer, project.id)).toHaveLength(2);

      const foreign = yield* Effect.result(
        projects.addGrant(actor, project.id, {
          principalType: "team",
          principalId: "foreign",
          role: "project:admin",
        }),
      );

      expect(Result.isFailure(foreign) && foreign.failure._tag).toBe("BadRequest");
      yield* db.query("test.removeTeam", (db) =>
        db.delete(schema.teamMember).where(eq(schema.teamMember.id, "tm")),
      );
      const lostAdmin = yield* Effect.result(projects.listGrants(developer, project.id));
      expect(Result.isFailure(lostAdmin) && lostAdmin.failure._tag).toBe("Forbidden");
      yield* projects.removeGrant(actor, project.id, "user", "dev");
      const lostRead = yield* Effect.result(projects.get(developer, project.id));
      expect(Result.isFailure(lostRead) && lostRead.failure._tag).toBe("Forbidden");
      yield* projects.addGrant(actor, project.id, {
        principalType: "user",
        principalId: "dev",
        role: "project:admin",
      });
      yield* db.query("test.removeOrgMember", (db) =>
        db.delete(schema.member).where(eq(schema.member.id, "dev-m")),
      );
      const lostMember = yield* Effect.result(projects.get(developer, project.id));
      expect(Result.isFailure(lostMember) && lostMember.failure._tag).toBe("Forbidden");
    }),
  ));

const trustInput = {
  provider: "github" as const,
  enabled: true,
  issuer: "https://token.actions.githubusercontent.com",
  claims: {
    aud: ["cache"],
    repository: ["org/repo"],
    repository_id: ["1"],
    repository_owner_id: ["2"],
    event_name: ["push"],
  },
  scope: "read write" as const,
  ttlSeconds: 600,
};

test("trust policy CRUD preserves ownership and creation time, scopes IDs and audits mutations", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;
      const project = yield* projects.create(actor, "a", { slug: "cache", name: "Cache" });
      const other = yield* projects.create(actor, "a", { slug: "other", name: "Other" });
      const policy = yield* projects.saveTrustPolicy(actor, project.id, trustInput);
      expect(policy).toMatchObject({ ...trustInput, projectId: project.id, createdBy: "u" });
      expect(yield* projects.listTrustPolicies(actor, project.id)).toEqual([policy]);

      const updated = yield* projects.saveTrustPolicy(
        actor,
        project.id,
        { ...trustInput, enabled: false, scope: "read" },
        policy.id,
      );

      expect(updated).toMatchObject({
        id: policy.id,
        createdAt: policy.createdAt,
        createdBy: "u",
        enabled: false,
        scope: "read",
      });

      const foreign = yield* Effect.result(
        projects.saveTrustPolicy(actor, other.id, trustInput, policy.id),
      );

      expect(Result.isFailure(foreign) && foreign.failure._tag).toBe("NotFound");
      yield* projects.deleteTrustPolicy(actor, project.id, policy.id);
      expect(yield* projects.listTrustPolicies(actor, project.id)).toEqual([]);

      const missing = yield* Effect.result(
        projects.deleteTrustPolicy(actor, project.id, policy.id),
      );

      expect(Result.isFailure(missing) && missing.failure._tag).toBe("NotFound");

      const events = yield* db.query("test.policyEvents", (db) =>
        db.select().from(schema.auditEvent),
      );

      expect(
        events
          .map((row) => row.payload.action)
          .filter((action) => isString(action) && action.includes("trust_policy")),
      ).toEqual([
        "project.trust_policy.create",
        "project.trust_policy.update",
        "project.trust_policy.delete",
      ]);
    }),
  ));

test("policy validation rejects unsafe issuers, missing audience, empty rules and invalid TTL", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const project = yield* projects.create(actor, "a", { slug: "cache", name: "Cache" });

      const invalidInputs: (typeof TrustPolicyRequest.Type)[] = [
        { ...trustInput, issuer: "http://issuer" },
        { ...trustInput, issuer: "https://issuer?" },
        { ...trustInput, issuer: "https://issuer/#" },
        { ...trustInput, issuer: "https://user:password@issuer" },
        { ...trustInput, claims: {} },
        {
          ...trustInput,
          claims: {
            repository: ["org/repo"],
            repository_id: ["1"],
            repository_owner_id: ["2"],
            event_name: ["push"],
          },
        },
        { ...trustInput, claims: { aud: [] } },
        { ...trustInput, claims: { aud: [""] } },
        { ...trustInput, ttlSeconds: 0 },
        { ...trustInput, ttlSeconds: 1.5 },
        { ...trustInput, ttlSeconds: 3601 },
      ];

      for (const input of invalidInputs) {
        const result = yield* Effect.result(projects.saveTrustPolicy(actor, project.id, input));
        expect(Result.isFailure(result) && result.failure._tag).toBe("BadRequest");
      }

      expect(yield* projects.listTrustPolicies(actor, project.id)).toEqual([]);
    }),
  ));

test("GitHub defaults are explicit, project-scoped, audited with creation, and disabled on deletion", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;

      const project = yield* projects.create(actor, "a", {
        slug: "cache",
        name: "Cache",
        github: {
          repository: "org/repo",
          repositoryId: "1",
          repositoryOwnerId: "2",
          defaultBranch: "develop",
          audience: "cache",
        },
      });

      const policies = yield* projects.listTrustPolicies(actor, project.id);
      expect(policies).toHaveLength(2);
      expect(policies.find((policy) => policy.scope === "read write")?.claims).toEqual({
        aud: ["cache"],
        repository: ["org/repo"],
        repository_id: ["1"],
        repository_owner_id: ["2"],
        event_name: ["push"],
        ref: ["refs/heads/develop"],
      });
      expect(policies.find((policy) => policy.scope === "read")?.claims).toEqual({
        aud: ["cache"],
        repository: ["org/repo"],
        repository_id: ["1"],
        repository_owner_id: ["2"],
        sub: ["repo:org/repo:pull_request"],
      });
      yield* projects.delete(actor, project.id, project.id);

      const disabled = yield* db.query("test.disabledPolicies", (db) =>
        db.select().from(schema.trustPolicy),
      );

      expect(disabled.every((policy) => !policy.enabled)).toBe(true);
      const blocked = yield* Effect.result(projects.saveTrustPolicy(actor, project.id, trustInput));
      expect(Result.isFailure(blocked) && blocked.failure._tag).toBe("Forbidden");
    }),
  ));

test("policy access requires project admin and live membership; passkey policy gates mutations", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;
      const project = yield* projects.create(actor, "a", { slug: "cache", name: "Cache" });
      const policy = yield* projects.saveTrustPolicy(actor, project.id, trustInput);
      yield* db.query("test.demote", (db) =>
        db.update(schema.member).set({ role: "member" }).where(eq(schema.member.id, "m")),
      );

      for (const operation of [
        projects.listTrustPolicies(actor, project.id),
        projects.saveTrustPolicy(actor, project.id, trustInput),
        projects.deleteTrustPolicy(actor, project.id, policy.id),
      ]) {
        const denied = yield* Effect.result(operation);
        expect(Result.isFailure(denied) && denied.failure._tag).toBe("Forbidden");
      }

      yield* db.query("test.promote", (db) =>
        db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, "m")),
      );
      yield* db.query("test.stepUp", (db) =>
        db.insert(schema.organizationPolicy).values({
          orgId: "a",
          settings: {
            ...defaultInstancePolicy,
            allowedEmailDomains: [],
            allowedGithubOrgs: [],
            allowedOidcIssuers: [],
            requirePasskeyForAdmins: true,
          },
          updatedAt: 1,
        }),
      );
      const denied = yield* Effect.result(projects.saveTrustPolicy(actor, project.id, trustInput));
      expect(Result.isFailure(denied) && denied.failure._tag).toBe("Forbidden");
      expect((yield* projects.listTrustPolicies(actor, project.id))[0]).toMatchObject({
        id: policy.id,
        errors: [{ code: "issuer_disallowed" }],
      });
      yield* db.query("test.revokeMembership", (db) =>
        db.delete(schema.member).where(eq(schema.member.id, "m")),
      );
      const revoked = yield* Effect.result(projects.listTrustPolicies(actor, project.id));
      expect(Result.isFailure(revoked) && revoked.failure._tag).toBe("Forbidden");
    }),
  ));

test("guardrails protect direct saves and updates, audit overrides and use tightened live settings", () =>
  run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const db = yield* Database;
      const project = yield* projects.create(actor, "a", {
        slug: "guardrails",
        name: "Guardrails",
      });
      const saved = yield* projects.saveTrustPolicy(actor, project.id, trustInput);
      const denied = yield* Effect.result(
        projects.saveTrustPolicy(
          actor,
          project.id,
          { ...trustInput, claims: { ...trustInput.claims, event_name: ["pull_request_target"] } },
          saved.id,
        ),
      );
      expect(Result.isFailure(denied) && denied.failure._tag).toBe("BadRequest");
      expect((yield* projects.listTrustPolicies(actor, project.id))[0]?.claims.event_name).toEqual([
        "push",
      ]);
      const override = yield* projects.saveTrustPolicy(
        actor,
        project.id,
        {
          ...trustInput,
          claims: { ...trustInput.claims, event_name: ["pull_request_target"] },
          allowUntrustedWrites: true,
        },
        saved.id,
      );
      expect(override.warnings.map((warning) => warning.code)).toContain(
        "untrusted_writes_enabled",
      );
      const events = yield* db.query("test.guardrailAudit", (db) =>
        db.select().from(schema.auditEvent),
      );
      const updates = events.filter((row) => row.payload.action === "project.trust_policy.update");
      expect(updates).toHaveLength(1);
      expect(updates[0]?.payload.metadata).toMatchObject({
        allowUntrustedWrites: true,
        warningCodes: ["untrusted_writes_enabled", "unrestricted_write_job"],
      });
      yield* db.query("test.strictOidcPolicy", (db) =>
        db.insert(schema.organizationPolicy).values({
          orgId: "a",
          updatedAt: 1,
          settings: {
            ...defaultInstancePolicy,
            allowedEmailDomains: [],
            allowedGithubOrgs: [],
            allowedOidcIssuers: [trustInput.issuer],
            requireBoundTokens: true,
            oidcWriteEnvironments: ["protected"],
          },
        }),
      );
      for (const input of [
        trustInput,
        { ...trustInput, requireBoundTokens: true },
        { ...trustInput, claims: { ...trustInput.claims, aud: ["attacker"] } },
      ]) {
        const result = yield* Effect.result(projects.saveTrustPolicy(actor, project.id, input));
        expect(Result.isFailure(result) && result.failure._tag).toBe("BadRequest");
      }
      const result = yield* projects.testTrustPolicies(actor, project.id, {
        claims: {
          iss: trustInput.issuer,
          aud: "cache",
          repository: "org/repo",
          repository_id: "1",
          repository_owner_id: "2",
          event_name: "pull_request_target",
        },
      });
      expect(result.matched).toBe(false);
      expect(result.policies[0]?.errors.map((error) => error.code)).toContain(
        "bound_tokens_required",
      );
      const constrained = yield* projects.saveTrustPolicy(actor, project.id, {
        ...trustInput,
        requireBoundTokens: true,
        claims: { ...trustInput.claims, environment: ["protected"] },
      });
      expect(constrained.errors).toEqual([]);
      const defaultsDenied = yield* Effect.result(
        projects.create(actor, "a", {
          slug: "defaults",
          name: "Defaults",
          github: {
            repository: "org/repo",
            repositoryId: "1",
            repositoryOwnerId: "2",
            defaultBranch: "main",
            audience: "cache",
          },
        }),
      );
      expect(Result.isFailure(defaultsDenied) && defaultsDenied.failure._tag).toBe("BadRequest");
      expect((yield* projects.list(actor, "a")).items.map((item) => item.slug)).toEqual([
        "guardrails",
      ]);
    }),
  ));
