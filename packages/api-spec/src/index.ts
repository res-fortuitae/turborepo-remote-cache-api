export * from "./common.ts";

export * from "./errors.ts";

export * from "./authorization.ts";

export * from "./cache.ts";

export * from "./oidc.ts";

export * from "./admin.ts";

export * from "./analytics.ts";

export * from "./audit.ts";

import { HttpApi } from "effect/http-api";
import { CacheApi } from "./cache.ts";
import { OidcApi } from "./oidc.ts";
import { AdminApi } from "./admin.ts";
import { AnalyticsApi } from "./analytics.ts";
import { AuditApi } from "./audit.ts";

export const Api = HttpApi.make("RemoteCache").add(
  CacheApi,
  OidcApi,
  AdminApi,
  AnalyticsApi,
  AuditApi,
);

export * from "./capabilities.ts";

export { PurgeFilter, PurgeReport } from "./purge.ts";
export {
  MULTIPART_PART_BYTES,
  MAX_MULTIPART_PARTS,
  MAX_EDGE_ARTIFACT_BYTES,
  MultipartCreate,
  MultipartComplete,
  MultipartCreated,
  UploadedPart,
} from "./uploads.ts";

export { DeveloperTokenRequest, DeveloperTokenApi } from "./oidc.ts";
export { HealthReport, SelfTestReport } from "./health.ts";
