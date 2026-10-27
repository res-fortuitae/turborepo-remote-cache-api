import type { ReactNode } from "react";
import { createContext, useContext, useEffect } from "react";
import { authClient } from "./auth-client.ts";

export interface Org {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

const OrgContext = createContext<Org | undefined>(undefined);

/** Org of the current `/orgs/:slug/*` route. Pages under that route can rely on it. */
export const useOrg = () => {
  const org = useContext(OrgContext);

  if (!org) throw new Error("useOrg must be used inside an organization route");

  return org;
};

export const useOptionalOrg = () => useContext(OrgContext);

/**
 * Keeps Better Auth's active organization in step with the URL, so native
 * org endpoints (members, invitations, groups, roles) act on the org on screen.
 */
export function OrgProvider({
  org,
  children,
}: {
  readonly org: Org;
  readonly children: ReactNode;
}) {
  const active = authClient.useActiveOrganization();

  useEffect(() => {
    if (!active.isPending && active.data?.id !== org.id)
      void authClient.organization.setActive({ organizationId: org.id });
  }, [active.isPending, active.data?.id, org.id]);

  return <OrgContext.Provider value={org}>{children}</OrgContext.Provider>;
}

export const orgPath = (org: Pick<Org, "slug">, path = "") =>
  `/orgs/${encodeURIComponent(org.slug)}${path}`;
