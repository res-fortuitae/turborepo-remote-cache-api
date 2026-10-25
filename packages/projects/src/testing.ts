import { AuditLogD1Only } from "@repo/audit";
import { AuthConfigTest } from "@repo/auth/testing";
import { AuthorizationLive } from "@repo/authz";
import { ProjectRepoLive } from "@repo/db";
import { DatabaseTest } from "@repo/db/testing";
import { Layer } from "effect";
import { ProjectLimits, ProjectsLive } from "./projects.ts";

/** Real services over migrated SQLite; no network or platform bindings. */
export const ProjectsTest = ProjectsLive.pipe(
  Layer.provide(Layer.mergeAll(ProjectRepoLive, AuthorizationLive, AuditLogD1Only)),
  Layer.provide(
    Layer.mergeAll(
      AuthConfigTest,
      Layer.succeed(ProjectLimits, { retentionDays: 30, maxArtifactBytes: 100_000_000 }),
    ),
  ),
  Layer.provideMerge(DatabaseTest),
);
