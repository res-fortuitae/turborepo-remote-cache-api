import { AuditLogD1Only } from "@repo/audit";
import { AuthConfigTest } from "@repo/auth/testing";
import { AuthorizationDatabaseLive } from "@repo/authz";
import { ProjectRepoLive } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { PolicyGuardrailsLive } from "@repo/oidc";
import { OidcAudience } from "@repo/deploy-config";
import { Layer } from "effect";
import { ProjectLimits, ProjectsLive } from "./projects.ts";
import { AuthorizationAuditLive } from "./authorization-audit.ts";

/** Real services over migrated SQLite; no network or platform bindings. */
export const ProjectsTest = ProjectsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectRepoLive,
      AuthorizationDatabaseLive.pipe(Layer.provide(AuthorizationAuditLive)),
      AuditLogD1Only,
    ).pipe(Layer.provide(AuditLogD1Only)),
  ),
  Layer.provide(
    Layer.mergeAll(
      AuthConfigTest,
      PolicyGuardrailsLive,
      Layer.succeed(OidcAudience, ["cache"]),
      Layer.succeed(ProjectLimits, { retentionDays: 30, maxArtifactBytes: 100_000_000 }),
    ),
  ),
  Layer.provideMerge(DatabaseTest),
);
