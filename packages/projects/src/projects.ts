import {
  BadRequest,
  Conflict,
  CreateProjectRequest,
  GrantRequest,
  Forbidden,
  NotFound,
  UpdateProjectRequest,
  type Project as ProjectResponse,
} from "@repo/api-spec";
import { AuditLog, type AuditInput, type AuditLogError } from "@repo/audit";
import { readInstancePolicy, requirePasskeyProof } from "@repo/auth";
import { Authorization, type SessionPrincipal, type ProjectAction } from "@repo/authz";
import { Database, ProjectRepo, schema, type Project } from "@repo/db";
import { AuthConfig, InstancePolicy, tightenPolicy } from "@repo/deploy-config";
import { and, eq, ne } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Schema } from "effect";

/** Host ceilings include the bucket's deployment retention and upload capability. */
export class ProjectLimits extends Context.Service<
  ProjectLimits,
  {
    readonly retentionDays: number;
    readonly maxArtifactBytes: number;
  }
>()("@repo/projects/ProjectLimits") {}

export interface ProjectActor extends SessionPrincipal {
  readonly display: string;
  readonly requestId: string;
  readonly ip: string;
  readonly userAgent: string;
}

const decodePolicy = Schema.decodeUnknownEffect(InstancePolicy);
const decodeCreate = Schema.decodeUnknownEffect(CreateProjectRequest);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateProjectRequest);
const decodeGrant = Schema.decodeUnknownEffect(GrantRequest);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Adapter failures are unknown by definition.
const slugConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;

  return (
    error.message.includes("UNIQUE constraint failed: project.org_id, project.slug") ||
    slugConflict(error.cause)
  );
};

const projects = Effect.gen(function* () {
  const database = yield* Database;
  const repo = yield* ProjectRepo;
  const authorization = yield* Authorization;
  const audit = yield* AuditLog;
  const config = yield* AuthConfig;
  const limits = yield* ProjectLimits;

  const event = (
    actor: ProjectActor,
    orgId: string,
    action: string,
    projectId?: string,
  ): AuditInput => ({
    scope: "org",
    orgId,
    projectId,
    actor: { type: "user", id: actor.userId, display: actor.display },
    action: `project.${action}`,
    target: { type: projectId ? "project" : "organization", id: projectId ?? orgId },
    outcome: "allow",
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
    metadata: {},
  });

  const requirePermission = Effect.fn("Projects.requirePermission")(function* (
    actor: ProjectActor,
    action: ProjectAction,
    orgId: string,
    projectId?: string,
  ) {
    yield* authorization
      .require(actor, action, { orgId, projectId })
      .pipe(
        Effect.catchTag("Forbidden", (error) =>
          audit
            .commit({ ...event(actor, orgId, action, projectId), outcome: "deny" }, () => [])
            .pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
  });

  const policyFor = Effect.fn("Projects.policy")(function* (orgId: string) {
    const instance = yield* database.query("Projects.instancePolicy", () =>
      readInstancePolicy(database.drizzle, config),
    );

    const [org] = yield* database.query("Projects.organizationPolicy", (db) =>
      db.select().from(schema.organizationPolicy).where(eq(schema.organizationPolicy.orgId, orgId)),
    );

    if (!org) return instance;
    const requested = yield* decodePolicy(org.settings);

    return yield* Effect.try(() => tightenPolicy(instance, requested));
  });

  const mutationPolicy = Effect.fn("Projects.mutationPolicy")(function* (
    actor: ProjectActor,
    orgId: string,
  ) {
    const policy = yield* policyFor(orgId);

    if (policy.requirePasskeyForAdmins) {
      yield* Effect.tryPromise({
        try: () => requirePasskeyProof(database.drizzle, actor.sessionId, actor.userId),
        catch: () => new Forbidden({ message: "A fresh passkey check is required" }),
      });
    }

    return policy;
  });

  const present = (row: Project, policy: typeof InstancePolicy.Type): ProjectResponse => ({
    ...row,
    retentionDays: Math.min(
      row.retentionDays ?? limits.retentionDays,
      limits.retentionDays,
      policy.retentionDays,
    ),
    maxArtifactBytes: Math.min(
      row.maxArtifactBytes ?? limits.maxArtifactBytes,
      limits.maxArtifactBytes,
      policy.quotaBytes,
    ),
    createdAt: new Date(row.createdAt).toISOString(),
    archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt).toISOString(),
  });

  const locate = Effect.fn("Projects.locate")(function* (id: string) {
    const row = yield* repo.locate(id);

    if (!row) return yield* new NotFound({ message: "Project not found" });

    return row;
  });

  const uniqueSlug = Effect.fn("Projects.uniqueSlug")(function* (
    orgId: string,
    slug: string,
    exceptId?: string,
  ) {
    const [existing] = yield* database.query("Projects.uniqueSlug", (db) =>
      db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(
          and(
            eq(schema.project.orgId, orgId),
            eq(schema.project.slug, slug),
            exceptId === undefined ? undefined : ne(schema.project.id, exceptId),
          ),
        )
        .limit(1),
    );

    if (existing)
      return yield* new Conflict({ message: "Project slug already exists in this organization" });
  });

  const commitMutation = (input: AuditInput, change: Parameters<typeof audit.commit>[1]) =>
    audit
      .commit(input, change)
      .pipe(
        Effect.catchTag("AuditLogError", (error): Effect.Effect<never, Conflict | AuditLogError> =>
          Effect.fail(
            slugConflict(error.cause)
              ? new Conflict({ message: "Project slug already exists in this organization" })
              : error,
          ),
        ),
      );

  return {
    listGrants: Effect.fn("Projects.listGrants")(function* (actor: ProjectActor, id: string) {
      const row = yield* locate(id);
      yield* requirePermission(actor, "grant", row.orgId, id);

      const rows = yield* database.query("Projects.listGrants", (db) =>
        db
          .select()
          .from(schema.projectGrant)
          .where(eq(schema.projectGrant.projectId, id))
          .orderBy(schema.projectGrant.principalType, schema.projectGrant.principalId),
      );

      return rows.map((grant) => ({
        ...grant,
        createdAt: new Date(grant.createdAt).toISOString(),
      }));
    }),
    addGrant: Effect.fn("Projects.addGrant")(function* (
      actor: ProjectActor,
      id: string,
      input: typeof GrantRequest.Type,
    ) {
      const row = yield* locate(id);
      yield* requirePermission(actor, "grant", row.orgId, id);
      yield* mutationPolicy(actor, row.orgId);
      const grant = yield* decodeGrant(input).pipe(
        Effect.mapError(() => new BadRequest({ message: "Invalid grant" })),
      );

      const eligible =
        grant.principalType === "user"
          ? yield* database.query("Projects.grantMember", (db) =>
              db
                .select()
                .from(schema.member)
                .where(
                  and(
                    eq(schema.member.organizationId, row.orgId),
                    eq(schema.member.userId, grant.principalId),
                  ),
                ),
            )
          : yield* database.query("Projects.grantTeam", (db) =>
              db
                .select()
                .from(schema.team)
                .where(
                  and(
                    eq(schema.team.organizationId, row.orgId),
                    eq(schema.team.id, grant.principalId),
                  ),
                ),
            );

      if (eligible.length === 0)
        return yield* new BadRequest({
          message: "Grant principal must belong to the project's organization",
        });
      const value = {
        ...grant,
        projectId: id,
        grantedBy: actor.userId,
        createdAt: yield* Clock.currentTimeMillis,
      };
      yield* audit.commit(
        {
          ...event(actor, row.orgId, "grant.add", id),
          metadata: {
            principalType: grant.principalType,
            principalId: grant.principalId,
            role: grant.role,
          },
        },
        (db) => [
          db
            .insert(schema.projectGrant)
            .values(value)
            .onConflictDoUpdate({
              target: [
                schema.projectGrant.projectId,
                schema.projectGrant.principalType,
                schema.projectGrant.principalId,
              ],
              set: { role: value.role, grantedBy: value.grantedBy, createdAt: value.createdAt },
            }),
        ],
      );

      return { ...value, createdAt: new Date(value.createdAt).toISOString() };
    }),
    removeGrant: Effect.fn("Projects.removeGrant")(function* (
      actor: ProjectActor,
      id: string,
      principalType: "user" | "team",
      principalId: string,
    ) {
      const row = yield* locate(id);
      yield* requirePermission(actor, "grant", row.orgId, id);
      yield* mutationPolicy(actor, row.orgId);
      yield* audit.commit(
        {
          ...event(actor, row.orgId, "grant.remove", id),
          metadata: { principalType, principalId },
        },
        (db) => [
          db
            .delete(schema.projectGrant)
            .where(
              and(
                eq(schema.projectGrant.projectId, id),
                eq(schema.projectGrant.principalType, principalType),
                eq(schema.projectGrant.principalId, principalId),
              ),
            ),
        ],
      );
    }),
    create: Effect.fn("Projects.create")(function* (
      actor: ProjectActor,
      orgId: string,
      input: typeof CreateProjectRequest.Type,
    ) {
      yield* requirePermission(actor, "create", orgId);

      const decoded = yield* decodeCreate(input).pipe(
        Effect.mapError(() => new BadRequest({ message: "Invalid project" })),
      );

      const policy = yield* mutationPolicy(actor, orgId);
      yield* uniqueSlug(orgId, decoded.slug);

      const row = {
        id: crypto.randomUUID(),
        orgId,
        slug: decoded.slug,
        name: decoded.name.trim(),
        description: decoded.description ?? null,
        retentionDays: Math.min(
          decoded.retentionDays ?? limits.retentionDays,
          limits.retentionDays,
          policy.retentionDays,
        ),
        maxArtifactBytes: Math.min(
          decoded.maxArtifactBytes ?? limits.maxArtifactBytes,
          limits.maxArtifactBytes,
          policy.quotaBytes,
        ),
        createdAt: yield* Clock.currentTimeMillis,
        archivedAt: null,
      } satisfies Project;

      yield* commitMutation(event(actor, orgId, "create", row.id), (db) => [
        db.insert(schema.project).values(row),
      ]);

      return present(row, policy);
    }),
    get: Effect.fn("Projects.get")(function* (actor: ProjectActor, id: string) {
      const row = yield* locate(id);
      yield* requirePermission(actor, "read", row.orgId, row.id);

      return present(row, yield* policyFor(row.orgId));
    }),
    list: Effect.fn("Projects.list")(function* (
      actor: ProjectActor,
      orgId: string,
      query: { readonly limit?: number; readonly cursor?: string } = {},
    ) {
      yield* requirePermission(actor, "read", orgId);
      const limit = query.limit ?? 50;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return yield* new BadRequest({ message: "Limit must be between 1 and 100" });

      if (query.cursor === "") return yield* new BadRequest({ message: "Cursor must be nonempty" });
      const rows = yield* repo.page(orgId, limit + 1, query.cursor);
      const page = rows.slice(0, limit);
      const policy = yield* policyFor(orgId);

      return {
        items: page.map((row) => present(row, policy)),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    }),
    update: Effect.fn("Projects.update")(function* (
      actor: ProjectActor,
      id: string,
      input: typeof UpdateProjectRequest.Type,
    ) {
      const before = yield* locate(id);
      yield* requirePermission(actor, "update", before.orgId, before.id);

      const decoded = yield* decodeUpdate(input).pipe(
        Effect.mapError(() => new BadRequest({ message: "Invalid project update" })),
      );

      if (Object.keys(decoded).length === 0)
        return yield* new BadRequest({ message: "At least one project field is required" });
      const policy = yield* mutationPolicy(actor, before.orgId);

      if (decoded.slug !== undefined) yield* uniqueSlug(before.orgId, decoded.slug, before.id);
      const now = yield* Clock.currentTimeMillis;
      const { archived, ...fields } = decoded;

      const changes: Partial<Project> = {
        ...fields,
        retentionDays: Math.min(
          fields.retentionDays ?? before.retentionDays ?? limits.retentionDays,
          limits.retentionDays,
          policy.retentionDays,
        ),
        maxArtifactBytes: Math.min(
          fields.maxArtifactBytes ?? before.maxArtifactBytes ?? limits.maxArtifactBytes,
          limits.maxArtifactBytes,
          policy.quotaBytes,
        ),
      };

      if (fields.name !== undefined) changes.name = fields.name.trim();

      if (archived !== undefined) changes.archivedAt = archived ? (before.archivedAt ?? now) : null;

      yield* commitMutation(
        event(
          actor,
          before.orgId,
          archived === undefined ? "update" : archived ? "archive" : "restore",
          id,
        ),
        (db) => [
          db
            .update(schema.project)
            .set(changes)
            .where(and(eq(schema.project.id, id), eq(schema.project.orgId, before.orgId))),
        ],
      );

      return present(yield* locate(id), policy);
    }),
  };
});

export class Projects extends Context.Service<Projects, Effect.Success<typeof projects>>()(
  "@repo/projects/Projects",
) {}

export const ProjectsLive = Layer.effect(Projects, projects);
