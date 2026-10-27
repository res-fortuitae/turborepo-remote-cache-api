import { Schema } from "effect";
import {
  TrustPolicy,
  TrustPolicyRequest,
  TestTrustPoliciesResponse,
  AuditPage,
} from "@repo/shared";
import { api } from "./api.ts";

const policies = (id: string) => `/projects/${encodeURIComponent(id)}/trust-policies`;
export const savePolicy = (project: string, input: unknown, id?: string) =>
  api(`${policies(project)}${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PUT" : "POST",
    body: Schema.decodeUnknownSync(TrustPolicyRequest)(input),
    schema: TrustPolicy,
  });
export const deletePolicy = (project: string, id: string) =>
  api(`${policies(project)}/${encodeURIComponent(id)}`, { method: "DELETE" });
export const testPolicies = (project: string, claims: unknown) =>
  api(`${policies(project)}/test`, {
    method: "POST",
    body: { claims },
    schema: TestTrustPoliciesResponse,
  });
export const recentExchanges = (org: string, signal?: AbortSignal) => {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 7 * 86400000).toISOString();
  return api(
    `/orgs/${encodeURIComponent(org)}/audit?${new URLSearchParams({ from, to, action: "oidc.exchange", limit: "50" })}`,
    { schema: AuditPage, signal },
  );
};

export interface CacheKey {
  readonly id: string;
  readonly name: string | null;
  readonly projectId: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly enabled: boolean;
  readonly lastUsedAt: number | null;
  readonly permissions:
    | string
    | { readonly project?: ReadonlyArray<string>; readonly cache?: ReadonlyArray<string> }
    | null;
}
export const listKeys = (org: string, signal?: AbortSignal) =>
  api<ReadonlyArray<CacheKey>>("/api/auth/cache-keys/list", {
    method: "POST",
    body: { organizationId: org },
    signal,
  });
export const createKey = (
  org: string,
  project: string,
  name: string,
  write: boolean,
  days: number,
) =>
  api<{ readonly id: string; readonly key: string }>("/api/auth/cache-keys/create", {
    method: "POST",
    body: {
      organizationId: org,
      name,
      expiresIn: days * 86400,
      permissions: { project: [project], cache: write ? ["read", "write"] : ["read"] },
    },
  });
export const revokeKey = (keyId: string) =>
  api("/api/auth/cache-keys/revoke", { method: "POST", body: { keyId } });
export const credentialPolicy = (org: string, signal?: AbortSignal) =>
  api<{
    readonly policy: {
      readonly apiKeys: "allowed" | "warn" | "disallowed";
      readonly maxApiKeyLifetimeDays: number;
      readonly maxTokenTtlSeconds: number;
      readonly requireBoundTokens: boolean;
    };
  }>("/api/auth/organization/policy", { method: "POST", body: { organizationId: org }, signal });

export const keyAttention = (
  key: Pick<CacheKey, "createdAt" | "lastUsedAt">,
  now = Date.now(),
) => ({
  old: now - Date.parse(key.createdAt) >= 90 * 86400000,
  unused: now - (key.lastUsedAt ?? Date.parse(key.createdAt)) >= 14 * 86400000,
});
