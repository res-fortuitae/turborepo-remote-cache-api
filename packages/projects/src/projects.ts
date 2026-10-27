import {
  BadRequest,
  Conflict,
  CreateProjectRequest,
  GrantRequest,
  Forbidden,
  NotFound,
  UpdateProjectRequest,
  TrustPolicyRequest,
  TestTrustPoliciesRequest,
  type Project as ProjectResponse,
} from "@repo/api-spec";
import { AuditLog, type AuditInput, type AuditLogError } from "@repo/audit";
import { readInstancePolicy, requirePasskeyProof } from "@repo/auth";
import { Authorization, type SessionPrincipal, type ProjectAction } from "@repo/authz";
import { Database, ProjectRepo, schema, type Project, type TrustPolicy } from "@repo/db";
import { PolicyGuardrails, type PolicyGuardrailSettings } from "@repo/oidc";
import { AuthConfig, InstancePolicy, OidcAudience, tightenPolicy } from "@repo/deploy-config";
import { ProjectRetentionRules, artifactPrefix } from "./maintenance.ts";
import { and, eq, ne, sql } from "drizzle-orm";
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
const decodeTrustPolicy = Schema.decodeUnknownEffect(TrustPolicyRequest);

const presentTrustPolicy = (row: TrustPolicy) => ({
  ...row.body,
  id: row.id,
  projectId: row.projectId,
  provider: row.provider,
  enabled: row.enabled,
  createdBy: row.createdBy,
  createdAt: new Date(row.createdAt).toISOString(),
});

const decodeProjectPermissions = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ project: Schema.optional(Schema.Array(Schema.String)) })),
);
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
  const guardrails = yield* PolicyGuardrails;
  const audiences = yield* OidcAudience;
  const retentionRules = yield* Effect.serviceOption(ProjectRetentionRules);

  const syncRetention = (row: Project, policy: typeof InstancePolicy.Type) =>
    retentionRules._tag === "Some"
      ? retentionRules.value
          .sync(
            row.id,
            artifactPrefix(row.orgId, row.id),
            Math.min(
              row.retentionDays ?? limits.retentionDays,
              limits.retentionDays,
              policy.retentionDays,
            ),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logError("Native retention unavailable; using sweeper", error),
            ),
          )
      : Effect.void;

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
    yield* authorization.require(actor, action, { orgId, projectId }).pipe(
      Effect.catchTag("AuthzError", (error) =>
        Effect.gen(function* () {
          if (error.reason === "unavailable") return yield* error;

          return yield* new Forbidden({ message: error.message });
        }),
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

  const guardrailSettings = (policy: typeof InstancePolicy.Type): PolicyGuardrailSettings => ({
    audiences,
    maxTokenTtlSeconds: policy.maxTokenTtlSeconds,
    allowedIssuers: policy.allowedOidcIssuers,
    requireBoundTokens: policy.requireBoundTokens,
    workflowRefs: policy.oidcWriteWorkflowRefs,
    environments: policy.oidcWriteEnvironments,
  });
  const checkTrustPolicy = (
    input: typeof TrustPolicyRequest.Type,
    policy: typeof InstancePolicy.Type,
  ) => {
    const report = guardrails.evaluate(input, guardrailSettings(policy));
    return report.errors.length > 0
      ? Effect.fail(
          new BadRequest({
            message: report.errors
              .map(
                (error) =>
                  `${error.code}${error.claim ? ` (${error.claim})` : ""}: ${error.message}`,
              )
              .join("; "),
          }),
        )
      : Effect.succeed(report);
  };

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
    firstHitAt: row.firstHitAt === null ? null : new Date(row.firstHitAt).toISOString(),
    lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt).toISOString(),
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

  const policyProject = Effect.fn("Projects.policyProject")(function* (
    actor: ProjectActor,
    id: string,
  ) {
    const row = yield* locate(id);
    yield* requirePermission(actor, "grant", row.orgId, id);

    return row;
  });

  const findTrustPolicy = Effect.fn("Projects.findTrustPolicy")(function* (
    id: string,
    policyId: string,
  ) {
    const row = yield* database.query("Projects.findTrustPolicy", (db) =>
      db
        .select()
        .from(schema.trustPolicy)
        .where(and(eq(schema.trustPolicy.projectId, id), eq(schema.trustPolicy.id, policyId)))
        .get(),
    );

    if (!row) return yield* new NotFound({ message: "Trust policy not found" });

    return row;
  });

  return {
    listTrustPolicies: Effect.fn("Projects.listTrustPolicies")(function* (
      actor: ProjectActor,
      id: string,
    ) {
      const project = yield* policyProject(actor, id);

      const rows = yield* database.query("Projects.listTrustPolicies", (db) =>
        db
          .select()
          .from(schema.trustPolicy)
          .where(eq(schema.trustPolicy.projectId, id))
          .orderBy(schema.trustPolicy.id),
      );

      const policy = yield* policyFor(project.orgId);
      return rows.map((row) => ({
        ...presentTrustPolicy(row),
        ...guardrails.evaluate(
          { ...row.body, provider: row.provider, enabled: row.enabled },
          guardrailSettings(policy),
        ),
      }));
    }),
    testTrustPolicies: Effect.fn("Projects.testTrustPolicies")(function* (
      actor: ProjectActor,
      id: string,
      input: typeof TestTrustPoliciesRequest.Type,
    ) {
      const project = yield* policyProject(actor, id);
      const decoded = yield* Schema.decodeUnknownEffect(TestTrustPoliciesRequest)(input).pipe(
        Effect.mapError(() => new BadRequest({ message: "Invalid sample claims" })),
      );
      const policy = yield* policyFor(project.orgId);
      const rows = yield* database.query("Projects.testTrustPolicies", (db) =>
        db.select().from(schema.trustPolicy).where(eq(schema.trustPolicy.projectId, id)),
      );
      return guardrails.test(project, rows, decoded.claims, guardrailSettings(policy));
    }),
    saveTrustPolicy: Effect.fn("Projects.saveTrustPolicy")(function* (
      actor: ProjectActor,
      id: string,
      input: typeof TrustPolicyRequest.Type,
      policyId?: string,
    ) {
      const project = yield* policyProject(actor, id);
      const policy = yield* mutationPolicy(actor, project.orgId);

      const decoded = yield* decodeTrustPolicy(input).pipe(
        Effect.mapError(() => new BadRequest({ message: "Invalid trust policy" })),
      );

      const report = yield* checkTrustPolicy(decoded, policy);
      const before = policyId === undefined ? undefined : yield* findTrustPolicy(id, policyId);
      const { provider, enabled, ...body } = decoded;

      const row: TrustPolicy = {
        id: before?.id ?? crypto.randomUUID(),
        projectId: id,
        provider,
        enabled,
        createdBy: before?.createdBy ?? actor.userId,
        createdAt: before?.createdAt ?? (yield* Clock.currentTimeMillis),
        body: {
          ...body,
          claims: Object.fromEntries(
            Object.entries(body.claims).map(([key, values]) => [key, [...values]]),
          ),
          refPatterns: body.refPatterns === undefined ? undefined : [...body.refPatterns],
        },
      };

      yield* audit.commit(
        {
          ...event(
            actor,
            project.orgId,
            before ? "trust_policy.update" : "trust_policy.create",
            id,
          ),
          metadata: {
            policyId: row.id,
            warningCodes: report.warnings.map((warning) => warning.code),
            allowUntrustedWrites: body.allowUntrustedWrites === true,
          },
        },
        (db) => [
          before
            ? db
                .update(schema.trustPolicy)
                .set({ provider, enabled, body: row.body })
                .where(and(eq(schema.trustPolicy.projectId, id), eq(schema.trustPolicy.id, row.id)))
            : db.insert(schema.trustPolicy).values(row),
        ],
      );

      return { ...presentTrustPolicy(row), ...report };
    }),
    deleteTrustPolicy: Effect.fn("Projects.deleteTrustPolicy")(function* (
      actor: ProjectActor,
      id: string,
      policyId: string,
    ) {
      const project = yield* policyProject(actor, id);
      yield* mutationPolicy(actor, project.orgId);
      yield* findTrustPolicy(id, policyId);
      yield* audit.commit(
        { ...event(actor, project.orgId, "trust_policy.delete", id), metadata: { policyId } },
        (db) => [
          db
            .delete(schema.trustPolicy)
            .where(and(eq(schema.trustPolicy.projectId, id), eq(schema.trustPolicy.id, policyId))),
        ],
      );
    }),
    delete: Effect.fn("Projects.delete")(function* (
      actor: ProjectActor,
      id: string,
      confirmation: string,
    ) {
      const row = yield* locate(id);
      yield* requirePermission(actor, "delete", row.orgId, id);
      yield* mutationPolicy(actor, row.orgId);

      if (confirmation !== id)
        return yield* new BadRequest({ message: "Confirm deletion with the project ID" });
      const now = yield* Clock.currentTimeMillis;
      yield* audit.commit(event(actor, row.orgId, "delete.requested", id), (db) => [
        db
          .insert(schema.projectDeletion)
          .values({ projectId: id, orgId: row.orgId, requestedAt: now })
          .onConflictDoNothing(),
        db.update(schema.project).set({ archivedAt: now }).where(eq(schema.project.id, id)),
        db
          .update(schema.trustPolicy)
          .set({ enabled: false })
          .where(eq(schema.trustPolicy.projectId, id)),
      ]);
    }),
    accessDirectory: Effect.fn("Projects.accessDirectory")(function* (
      actor: ProjectActor,
      id: string,
    ) {
      const row = yield* locate(id);
      yield* requirePermission(actor, "grant", row.orgId, id);
      const members = yield* database.query("Projects.directoryMembers", (db) =>
        db
          .select({
            member: schema.member,
            user: {
              id: schema.user.id,
              name: schema.user.name,
              email: schema.user.email,
              image: schema.user.image,
            },
          })
          .from(schema.member)
          .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
          .where(eq(schema.member.organizationId, row.orgId)),
      );
      const groups = yield* database.query("Projects.directoryTeams", (db) =>
        db.select().from(schema.team).where(eq(schema.team.organizationId, row.orgId)),
      );
      const groupMembers = yield* database.query("Projects.directoryTeamMembers", (db) =>
        db
          .select({
            id: schema.teamMember.id,
            teamId: schema.teamMember.teamId,
            userId: schema.teamMember.userId,
          })
          .from(schema.teamMember)
          .innerJoin(schema.team, eq(schema.teamMember.teamId, schema.team.id))
          .where(eq(schema.team.organizationId, row.orgId)),
      );
      const roles = yield* database.query("Projects.directoryRoles", (db) =>
        db
          .select()
          .from(schema.organizationRole)
          .where(eq(schema.organizationRole.organizationId, row.orgId)),
      );
      return {
        members: members.map(({ member, user }) => ({
          ...member,
          createdAt: member.createdAt.toISOString(),
          user,
        })),
        groups: groups.map((group) => ({
          id: group.id,
          name: group.name,
          createdAt: group.createdAt.toISOString(),
        })),
        groupMembers,
        // The access explainer needs project permissions, not the rest of the role catalog.
        roles: roles.map((role) => ({
          id: role.id,
          role: role.role,
          permission: { project: decodeProjectPermissions(role.permission).project ?? [] },
        })),
      };
    }),
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
        firstHitAt: null,
        lastSeenAt: null,
      } satisfies Project;

      const defaultBodies: TrustPolicy["body"][] =
        decoded.github === undefined
          ? []
          : [
              {
                issuer: "https://token.actions.githubusercontent.com",
                ttlSeconds: 600,
                label: "GitHub default branch",
                claims: {
                  aud: [decoded.github.audience],
                  repository: [decoded.github.repository],
                  repository_id: [decoded.github.repositoryId],
                  repository_owner_id: [decoded.github.repositoryOwnerId],
                  ref: [`refs/heads/${decoded.github.defaultBranch}`],
                  event_name: ["push"],
                },
                scope: "read write",
              },
              {
                issuer: "https://token.actions.githubusercontent.com",
                ttlSeconds: 600,
                label: "GitHub pull requests",
                claims: {
                  aud: [decoded.github.audience],
                  repository: [decoded.github.repository],
                  repository_id: [decoded.github.repositoryId],
                  repository_owner_id: [decoded.github.repositoryOwnerId],
                  sub: [`repo:${decoded.github.repository}:pull_request`],
                },
                scope: "read",
              },
            ];

      for (const body of defaultBodies) {
        yield* checkTrustPolicy({ ...body, provider: "github", enabled: true }, policy);
      }
      const defaults: TrustPolicy[] = defaultBodies.map((body) => ({
        id: crypto.randomUUID(),
        projectId: row.id,
        provider: "github",
        enabled: true,
        createdBy: actor.userId,
        createdAt: row.createdAt,
        body,
      }));

      yield* commitMutation(
        {
          ...event(actor, orgId, "create", row.id),
          metadata: { defaultTrustPolicyIds: defaults.map((policy) => policy.id) },
        },
        (db) => [
          db.insert(schema.project).values(row),
          db.insert(schema.projectRetention).values({ projectId: row.id, scannedAt: 0 }),
          ...defaults.map((policy) => db.insert(schema.trustPolicy).values(policy)),
        ],
      );

      yield* syncRetention(row, policy);

      return present(row, policy);
    }),
    get: Effect.fn("Projects.get")(function* (actor: ProjectActor, id: string) {
      const row = yield* locate(id);
      yield* requirePermission(actor, "read", row.orgId, row.id);

      return present(row, yield* policyFor(row.orgId));
    }),
    /** Live totals from the upload-path ledger; reconciliation corrects drift daily. */
    storage: Effect.fn("Projects.storage")(function* (actor: ProjectActor, id: string) {
      const row = yield* locate(id);
      const [deletion] = yield* database.query("Projects.storageDeletion", (db) =>
        db
          .select()
          .from(schema.projectDeletion)
          .where(eq(schema.projectDeletion.projectId, row.id)),
      );

      // Authorization fails closed for projects being deleted; deletion progress
      // stays visible to members who can read every project in the org.
      if (deletion) yield* requirePermission(actor, "read", row.orgId);
      else yield* requirePermission(actor, "read", row.orgId, row.id);
      const scope = and(
        eq(schema.artifactUsage.orgId, row.orgId),
        eq(schema.artifactUsage.projectId, row.id),
      );
      const [[objects], [usage]] = yield* Effect.all([
        database.query("Projects.storageObjects", (db) =>
          db
            .select({
              count: sql<number>`count(*)`,
              lastUploadAt: sql<number | null>`max(${schema.artifactUsage.observedAt})`,
            })
            .from(schema.artifactUsage)
            .where(scope),
        ),
        database.query("Projects.storageBytes", (db) =>
          db
            .select()
            .from(schema.projectUsage)
            .where(
              and(
                eq(schema.projectUsage.orgId, row.orgId),
                eq(schema.projectUsage.projectId, row.id),
              ),
            ),
        ),
      ]);
      const policy = yield* policyFor(row.orgId);
      const iso = (value: number | null | undefined) =>
        value ? new Date(value).toISOString() : null;

      return {
        projectId: row.id,
        bytes: Math.max(0, usage?.bytes ?? 0),
        objects: objects?.count ?? 0,
        lastUploadAt: iso(objects?.lastUploadAt),
        reconciledAt: iso(usage?.reconciledAt),
        deletionRequestedAt: iso(deletion?.requestedAt),
        limits: {
          quotaBytes: policy.quotaBytes,
          maxRetentionDays: Math.min(limits.retentionDays, policy.retentionDays),
          maxArtifactBytes: Math.min(limits.maxArtifactBytes, policy.quotaBytes),
        },
      };
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
          db
            .insert(schema.projectRetention)
            .values({ projectId: id, scannedAt: 0 })
            .onConflictDoUpdate({
              target: schema.projectRetention.projectId,
              set: { scannedAt: 0, cursor: null },
            }),
        ],
      );

      const updated = yield* locate(id);
      yield* syncRetention(updated, policy);

      return present(updated, policy);
    }),
  };
});

export class Projects extends Context.Service<Projects, Effect.Success<typeof projects>>()(
  "@repo/projects/Projects",
) {}

export const ProjectsLive = Layer.effect(Projects, projects);
