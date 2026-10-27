import { api } from "./api.ts";
import type { Org } from "./org.tsx";
export interface InstanceOrg extends Org {
  readonly archivedAt: number | null;
  readonly projects: number;
  readonly lastSeenAt: number | null;
  readonly storageBytes: number;
}
export interface Elevation {
  readonly id: string;
  readonly orgId: string;
  readonly reason: string;
  readonly expiresAt: number;
  readonly organization: Org;
}
export interface InstanceUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly banned?: boolean | null;
  readonly banReason?: string | null;
  readonly createdAt: string;
}
export type Policy = Record<string, string | number | boolean | ReadonlyArray<string> | undefined>;
const root = "/api/auth/instance";
export async function instanceOrgs(signal?: AbortSignal) {
  const items: InstanceOrg[] = [];
  let cursor: string | null = null;
  do {
    const page: { organizations: InstanceOrg[]; nextCursor: string | null } = await api(
      `${root}/orgs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      { signal },
    );
    items.push(...page.organizations);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
export const elevations = (signal?: AbortSignal) =>
  api<{ elevations: ReadonlyArray<Elevation> }>(`${root}/orgs/elevations`, { signal });
export const elevate = (orgId: string, reason: string, ttlSeconds: number) =>
  api<{ elevation: Elevation }>(`${root}/orgs/elevate`, {
    method: "POST",
    body: { orgId, reason, ttlSeconds },
  });
export const leaveElevation = (orgId: string) =>
  api(`${root}/orgs/leave`, { method: "POST", body: { orgId } });
export const instancePolicy = (signal?: AbortSignal) =>
  api<{ policy: Policy; ceilings: Policy }>(`${root}/settings`, { signal });
export const saveInstancePolicy = (policy: Policy) =>
  api<{ policy: Policy }>(`${root}/settings`, { method: "POST", body: { policy } });
export const listInstanceUsers = (search: string, offset: number, signal?: AbortSignal) =>
  api<{ users: ReadonlyArray<InstanceUser>; total: number }>(
    `/api/auth/admin/list-users?${new URLSearchParams({ limit: "50", offset: String(offset), ...(search ? { searchValue: search, searchField: "email", searchOperator: "contains" } : {}) })}`,
    { signal },
  );
export const banUser = (userId: string, reason: string) =>
  api("/api/auth/admin/ban-user", { method: "POST", body: { userId, banReason: reason } });
export const unbanUser = (userId: string) =>
  api("/api/auth/admin/unban-user", { method: "POST", body: { userId } });
export const revokeSessions = (userId: string) =>
  api("/api/auth/admin/revoke-user-sessions", { method: "POST", body: { userId } });
