import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import {
  CacheScope,
  CiProvider,
  Id,
  NonNegativeInteger,
  PaginationQuery,
  PositiveInteger,
  ProjectRole,
  Timestamp,
} from "./common.ts";
import { ApiErrors } from "./http-errors.ts";
import { ApiAuthorization } from "./authorization.ts";

export const ProjectSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);

const ProjectName = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(100));
const ProjectDescription = Schema.String.check(Schema.isMaxLength(2000));
const ProjectLimit = PositiveInteger.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

export const CreateProjectRequest = Schema.Struct({
  slug: ProjectSlug,
  name: ProjectName,
  description: Schema.optional(ProjectDescription),
  retentionDays: Schema.optional(ProjectLimit),
  maxArtifactBytes: Schema.optional(ProjectLimit),
  github: Schema.optional(
    Schema.Struct({
      repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
      repositoryId: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
      repositoryOwnerId: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
      defaultBranch: Schema.NonEmptyString,
      audience: Schema.NonEmptyString,
    }),
  ),
});

export const DeleteProjectRequest = Schema.Struct({ confirmation: Id });

export const UpdateProjectRequest = Schema.Struct({
  slug: Schema.optional(ProjectSlug),
  name: Schema.optional(ProjectName),
  description: Schema.optional(Schema.NullOr(ProjectDescription)),
  retentionDays: Schema.optional(ProjectLimit),
  maxArtifactBytes: Schema.optional(ProjectLimit),
  archived: Schema.optional(Schema.Boolean),
});

export const Project = Schema.Struct({
  id: Id,
  orgId: Id,
  slug: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.NullOr(Schema.String),
  retentionDays: PositiveInteger,
  maxArtifactBytes: PositiveInteger,
  createdAt: Timestamp,
  archivedAt: Schema.NullOr(Timestamp),
  /** First successful cache read; drives onboarding's live check. */
  firstHitAt: Schema.NullOr(Timestamp),
  lastSeenAt: Schema.NullOr(Timestamp),
});

/** Ledger totals for a project's stored artifacts. */
export const ProjectStorage = Schema.Struct({
  projectId: Id,
  bytes: NonNegativeInteger,
  objects: NonNegativeInteger,
  lastUploadAt: Schema.NullOr(Timestamp),
  reconciledAt: Schema.NullOr(Timestamp),
  /** Set while durable deletion removes the project's artifacts. */
  deletionRequestedAt: Schema.NullOr(Timestamp),
  /** Effective ceilings: deployment limits tightened by instance and org policy. */
  limits: Schema.Struct({
    quotaBytes: PositiveInteger,
    maxRetentionDays: PositiveInteger,
    maxArtifactBytes: PositiveInteger,
  }),
});

export const ArtifactSigningStatus = Schema.Struct({
  required: Schema.Boolean,
  instanceRequired: Schema.Boolean,
  keys: Schema.Array(
    Schema.Struct({
      id: Id,
      createdAt: NonNegativeInteger,
      retiredAt: Schema.NullOr(NonNegativeInteger),
    }),
  ),
});

export const QuotaSettings = Schema.Struct({
  storageBytes: Schema.NullOr(ProjectLimit),
  bandwidthBytes: Schema.NullOr(ProjectLimit),
  requests: Schema.NullOr(ProjectLimit),
  onQuotaExceeded: Schema.Literals(["reject", "evict-oldest"]),
});
export const QuotaUsage = Schema.Struct({
  storageBytes: NonNegativeInteger,
  bandwidthBytes: NonNegativeInteger,
  requests: NonNegativeInteger,
  reservedBytes: NonNegativeInteger,
});
export const QuotaStatus = Schema.Struct({
  org: Schema.Struct({ usage: QuotaUsage, limits: QuotaSettings }),
  project: Schema.Struct({ usage: QuotaUsage, limits: QuotaSettings }),
  overLimit: Schema.Boolean,
  day: Timestamp,
  eviction: Schema.NullOr(
    Schema.Struct({
      id: Id,
      state: Schema.Literals(["scanning", "deleting", "complete"]),
      removed: NonNegativeInteger,
      removedBytes: NonNegativeInteger,
    }),
  ),
});

export const ProjectList = Schema.Struct({
  items: Schema.Array(Project),
  nextCursor: Schema.NullOr(Schema.String),
});

export const GrantRequest = Schema.Struct({
  principalType: Schema.Literals(["user", "team"]),
  principalId: Id,
  role: ProjectRole,
});

export const ProjectGrant = Schema.Struct({
  ...GrantRequest.fields,
  projectId: Id,
  grantedBy: Id,
  createdAt: Timestamp,
});

export const ProjectGrants = Schema.Array(ProjectGrant);

/** Directory visible only to callers authorized to manage this project's grants. */
export const ProjectAccessDirectory = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      id: Id,
      userId: Id,
      role: Schema.String,
      createdAt: Timestamp,
      user: Schema.Struct({
        id: Id,
        name: Schema.String,
        email: Schema.String,
        image: Schema.NullOr(Schema.String),
      }),
    }),
  ),
  groups: Schema.Array(Schema.Struct({ id: Id, name: Schema.String, createdAt: Timestamp })),
  groupMembers: Schema.Array(Schema.Struct({ id: Id, teamId: Id, userId: Id })),
  roles: Schema.Array(
    Schema.Struct({
      id: Id,
      role: Schema.String,
      permission: Schema.Struct({ project: Schema.Array(Schema.String) }),
    }),
  ),
});

const PolicyIssuer = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value: string) => {
      try {
        const url = new URL(value);

        return (
          url.protocol === "https:" &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password &&
          !value.includes("?") &&
          !value.includes("#")
        );
      } catch {
        return false;
      }
    },
    { message: "Issuer must be HTTPS without credentials, query or fragment" },
  ),
);

const ClaimValues = Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1));

const PolicyClaims = Schema.Record(Schema.NonEmptyString, ClaimValues).check(
  Schema.makeFilter(
    (claims: Record<string, readonly string[]>) =>
      Object.hasOwn(claims, "aud") && (claims.aud?.length ?? 0) > 0,
    { message: "An audience claim rule is required" },
  ),
);

export const TrustPolicyBody = Schema.Struct({
  issuer: PolicyIssuer,
  claims: PolicyClaims,
  label: Schema.optional(Schema.String),
  scope: CacheScope,
  ttlSeconds: PositiveInteger.check(Schema.isLessThanOrEqualTo(3600)),
  refPatterns: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  requireBoundTokens: Schema.optional(Schema.Boolean),
  allowUntrustedWrites: Schema.optional(Schema.Boolean),
});

export const TrustPolicyRequest = Schema.Struct({
  provider: CiProvider,
  enabled: Schema.Boolean,
  ...TrustPolicyBody.fields,
});

export const PolicyFinding = Schema.Struct({
  code: Schema.String,
  claim: Schema.optional(Schema.String),
  message: Schema.String,
});
export const PolicyGuardrailReport = Schema.Struct({
  errors: Schema.Array(PolicyFinding),
  warnings: Schema.Array(PolicyFinding),
});
export const TestTrustPoliciesRequest = Schema.Struct({
  claims: Schema.Record(Schema.String, Schema.Json),
});
export const TestTrustPoliciesResponse = Schema.Struct({
  simulation: Schema.Literal(true),
  matched: Schema.Boolean,
  policyIds: Schema.Array(Id),
  scope: Schema.optional(CacheScope),
  ttlSeconds: Schema.optional(PositiveInteger),
  requireBoundTokens: Schema.optional(Schema.Boolean),
  policies: Schema.Array(
    Schema.Struct({
      policyId: Id,
      enabled: Schema.Boolean,
      failedClaims: Schema.Array(Schema.String),
      checks: Schema.Array(
        Schema.Struct({ claim: Schema.String, matched: Schema.Boolean, message: Schema.String }),
      ),
      ...PolicyGuardrailReport.fields,
    }),
  ),
});

export const TrustPolicy = Schema.Struct({
  ...TrustPolicyRequest.fields,
  ...PolicyGuardrailReport.fields,
  id: Id,
  projectId: Id,
  createdBy: Id,
  createdAt: Timestamp,
});

export const TrustPolicyList = Schema.Array(TrustPolicy);
export const OrgParams = Schema.Struct({ id: Id });
export const ProjectParams = Schema.Struct({ id: Id });

export const GrantParams = Schema.Struct({
  id: Id,
  principalType: GrantRequest.fields.principalType,
  principalId: Id,
});

export const TrustPolicyParams = Schema.Struct({ id: Id, policyId: Id });

export const AdminApi = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("listProjects", "/orgs/:id/projects", {
      params: OrgParams,
      query: PaginationQuery,
      success: ProjectList,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post("createProject", "/orgs/:id/projects", {
      params: OrgParams,
      payload: CreateProjectRequest,
      success: Project.pipe(HttpApiSchema.status(201)),
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("getProject", "/projects/:id", {
      params: ProjectParams,
      success: Project,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("getProjectStorage", "/projects/:id/storage", {
      params: ProjectParams,
      success: ProjectStorage,
      error: ApiErrors,
    }),
    HttpApiEndpoint.patch("updateProject", "/projects/:id", {
      params: ProjectParams,
      payload: UpdateProjectRequest,
      success: Project,
      error: ApiErrors,
    }),
    HttpApiEndpoint.delete("deleteProject", "/projects/:id", {
      params: ProjectParams,
      payload: DeleteProjectRequest,
      success: HttpApiSchema.Accepted,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("getAccessDirectory", "/projects/:id/access-directory", {
      params: ProjectParams,
      success: ProjectAccessDirectory,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("listGrants", "/projects/:id/grants", {
      params: ProjectParams,
      success: ProjectGrants,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post("addGrant", "/projects/:id/grants", {
      params: ProjectParams,
      payload: GrantRequest,
      success: ProjectGrant.pipe(HttpApiSchema.status(201)),
      error: ApiErrors,
    }),
    HttpApiEndpoint.delete("removeGrant", "/projects/:id/grants/:principalType/:principalId", {
      params: GrantParams,
      success: HttpApiSchema.NoContent,
      error: ApiErrors,
    }),
    HttpApiEndpoint.get("listTrustPolicies", "/projects/:id/trust-policies", {
      params: ProjectParams,
      success: TrustPolicyList,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post("testTrustPolicies", "/projects/:id/trust-policies/test", {
      params: ProjectParams,
      payload: TestTrustPoliciesRequest,
      success: TestTrustPoliciesResponse,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post("createTrustPolicy", "/projects/:id/trust-policies", {
      params: ProjectParams,
      payload: TrustPolicyRequest,
      success: TrustPolicy.pipe(HttpApiSchema.status(201)),
      error: ApiErrors,
    }),
    HttpApiEndpoint.put("updateTrustPolicy", "/projects/:id/trust-policies/:policyId", {
      params: TrustPolicyParams,
      payload: TrustPolicyRequest,
      success: TrustPolicy,
      error: ApiErrors,
    }),
    HttpApiEndpoint.delete("deleteTrustPolicy", "/projects/:id/trust-policies/:policyId", {
      params: TrustPolicyParams,
      success: HttpApiSchema.NoContent,
      error: ApiErrors,
    }),
  )
  .middleware(ApiAuthorization);

export type Project = typeof Project.Type;

export type ProjectGrant = typeof ProjectGrant.Type;

export type TrustPolicy = typeof TrustPolicy.Type;
