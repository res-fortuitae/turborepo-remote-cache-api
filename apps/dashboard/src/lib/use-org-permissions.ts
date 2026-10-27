import { authClient } from "./auth-client.ts";
import { can, effectivePermissions, listRoles } from "./org-admin.ts";
import { useOrg } from "./org.tsx";
import { useResource } from "./use-resource.ts";

/** The signed-in member's role and permissions in the org on screen. */
export function useOrgPermissions() {
  const org = useOrg();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const state = useResource(userId ? `my-role:${org.id}:${userId}` : null, async (signal) => {
    const [role, roles] = await Promise.all([
      authClient.organization.getActiveMemberRole({
        query: { organizationId: org.id },
        fetchOptions: { signal },
      }),
      // Members without ac:read cannot list roles; built-in roles still resolve.
      listRoles(org.id, signal).catch(() => []),
    ]);

    return { role: role.data?.role ?? "", roles };
  });
  const permissions = state.data ? effectivePermissions(state.data.role, state.data.roles) : {};

  return {
    ready: state.status === "ready",
    role: state.data?.role ?? "",
    can: (resource: string, action: string) => can(permissions, resource, action),
    reload: state.reload,
  };
}
