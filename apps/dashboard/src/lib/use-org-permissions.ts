import { api } from "./api.ts";
import type { OrganizationPermissions } from "@repo/shared";
import { authClient } from "./auth-client.ts";
import { can } from "./org-admin.ts";
import { useOrg } from "./org.tsx";
import { useResource } from "./use-resource.ts";

/** The signed-in member's role and permissions in the org on screen. */
export function useOrgPermissions() {
  const org = useOrg();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const state = useResource(userId ? `my-role:${org.id}:${userId}` : null, async (signal) => {
    return api<{ readonly role: string; readonly permissions: OrganizationPermissions }>(
      `/api/auth/organization/my-permissions?${new URLSearchParams({ organizationId: org.id })}`,
      { signal },
    );
  });
  const permissions = state.data?.permissions ?? {};

  return {
    ready: state.status === "ready",
    role: state.data?.role ?? "",
    can: (resource: string, action: string) => can(permissions, resource, action),
    reload: state.reload,
  };
}
