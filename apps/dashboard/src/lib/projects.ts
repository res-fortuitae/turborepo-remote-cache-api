import {
  Project,
  ProjectGrants,
  ProjectAccessDirectory,
  ProjectList,
  ProjectStorage,
  PurgeReport,
  TrustPolicyList,
} from "@repo/shared";
import { api } from "./api.ts";

const project = (id: string) => `/projects/${encodeURIComponent(id)}`;

export type ProjectRole = "project:admin" | "cache:write" | "cache:read";

export const projectRoles: ReadonlyArray<{
  readonly role: ProjectRole;
  readonly label: string;
  readonly detail: string;
}> = [
  { role: "cache:read", label: "Read", detail: "Restore cached artifacts" },
  { role: "cache:write", label: "Read and write", detail: "Restore and upload artifacts" },
  { role: "project:admin", label: "Admin", detail: "Write, settings, grants, credentials" },
];

export async function listProjects(
  orgId: string,
  signal?: AbortSignal,
): Promise<typeof ProjectList.Type> {
  const items: Array<typeof Project.Type> = [];
  let cursor: string | null = null;
  do {
    const page: typeof ProjectList.Type = await api(
      `/orgs/${encodeURIComponent(orgId)}/projects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { schema: ProjectList, signal },
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return { items, nextCursor: null };
}

export const createProject = (
  orgId: string,
  body: { readonly name: string; readonly slug: string },
) => api(`/orgs/${encodeURIComponent(orgId)}/projects`, { method: "POST", body, schema: Project });

export const getProject = (id: string, signal?: AbortSignal) =>
  api(project(id), { schema: Project, signal });

export const updateProject = (
  id: string,
  body: Partial<{
    readonly name: string;
    readonly slug: string;
    readonly description: string | null;
    readonly retentionDays: number;
    readonly maxArtifactBytes: number;
    readonly archived: boolean;
  }>,
) => api(project(id), { method: "PATCH", body, schema: Project });

export const deleteProject = (id: string) =>
  api(project(id), { method: "DELETE", body: { confirmation: id } });

export const getStorage = (id: string, signal?: AbortSignal) =>
  api(`${project(id)}/storage`, { schema: ProjectStorage, signal });

export const listGrants = (id: string, signal?: AbortSignal) =>
  api(`${project(id)}/grants`, { schema: ProjectGrants, signal });

export const addGrant = (
  id: string,
  body: {
    readonly principalType: "user" | "team";
    readonly principalId: string;
    readonly role: ProjectRole;
  },
) => api(`${project(id)}/grants`, { method: "POST", body });

export const removeGrant = (id: string, principalType: "user" | "team", principalId: string) =>
  api(`${project(id)}/grants/${principalType}/${encodeURIComponent(principalId)}`, {
    method: "DELETE",
  });

export const listTrustPolicies = (id: string, signal?: AbortSignal) =>
  api(`${project(id)}/trust-policies`, { schema: TrustPolicyList, signal });

/** Every artifact was uploaded after the epoch, so this filter selects the whole cache. */
export const EVERYTHING = { since: "1970-01-01T00:00:00.000Z" } as const;

export const previewPurge = (id: string, filter: object) =>
  api(`${project(id)}/purges`, { method: "POST", body: filter, schema: PurgeReport });

export const getPurge = (id: string, jobId: string, signal?: AbortSignal) =>
  api(`${project(id)}/purges/${encodeURIComponent(jobId)}`, { schema: PurgeReport, signal });

export const confirmPurge = (id: string, jobId: string) =>
  api(`${project(id)}/purges/${encodeURIComponent(jobId)}/confirm`, {
    method: "POST",
    schema: PurgeReport,
  });

/** Repositories that can reach the project, from its trust policies' claims. */
export const connectedRepositories = (policies: typeof TrustPolicyList.Type) => {
  const repos = new Map<
    string,
    { provider: string; scopes: Set<string>; enabled: boolean; policies: number }
  >();

  for (const policy of policies) {
    const names = policy.claims.repository ??
      policy.claims.project_path ??
      policy.claims.repository_name ?? [`${policy.provider} (${policy.label ?? policy.issuer})`];

    for (const name of names) {
      const entry = repos.get(name) ?? {
        provider: policy.provider,
        scopes: new Set<string>(),
        enabled: false,
        policies: 0,
      };

      if (policy.enabled) {
        entry.scopes.add(policy.scope);
        entry.enabled = true;
      }
      entry.policies += 1;
      repos.set(name, entry);
    }
  }

  return [...repos.entries()]
    .map(([name, entry]) => ({
      name,
      provider: entry.provider,
      enabled: entry.enabled,
      policies: entry.policies,
      write: entry.scopes.has("read write"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** Project administrators can select principals without organization role-catalog access. */
export const accessDirectory = (projectId: string, signal?: AbortSignal) =>
  api(`${project(projectId)}/access-directory`, { signal, schema: ProjectAccessDirectory });
