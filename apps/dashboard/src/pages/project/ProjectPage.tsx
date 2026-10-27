import { AlertTriangle, ArrowLeft, Archive, GitBranch } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Progress } from "@repo/ui/components/progress";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import {
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  formatBytes,
} from "../../components/common.tsx";
import { ApiError } from "../../lib/api.ts";
import { orgPath, useOrg } from "../../lib/org.tsx";
import {
  connectedRepositories,
  getProject,
  getStorage,
  listGrants,
  listTrustPolicies,
} from "../../lib/projects.ts";
import { href, navigate, splitLocation, useLocation } from "../../lib/router.tsx";
import { useOrgPermissions } from "../../lib/use-org-permissions.ts";
import { useResource } from "../../lib/use-resource.ts";
import { useEffect, useState } from "react";
import { AccessTab } from "./AccessTab.tsx";
import { SettingsTab } from "./SettingsTab.tsx";
import { StorageTab } from "./StorageTab.tsx";

const tabs = ["settings", "access", "storage", "repositories"] as const;
type Tab = (typeof tabs)[number];

function Repositories({ projectId }: { readonly projectId: string }) {
  const policies = useResource(`policies:${projectId}`, (signal) =>
    listTrustPolicies(projectId, signal),
  );

  if (policies.status === "error")
    return <ErrorState error={policies.error} onRetry={policies.reload} />;

  if (!policies.data) return <LoadingRows rows={2} />;
  const repos = connectedRepositories(policies.data);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected repositories</CardTitle>
        <CardDescription>
          CI identities that trust policies let into this project. Manage them under Credentials.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {repos.length === 0 ? (
          <EmptyState
            icon={<GitBranch />}
            title="No connected repositories"
            description="Add a trust policy so CI can use the cache without secrets."
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {repos.map((repo) => (
              <li
                key={repo.name}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <span className="flex items-center gap-2">
                  <code className="font-mono text-sm">{repo.name}</code>
                  <Badge variant="outline">{repo.provider}</Badge>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {repo.policies} polic{repo.policies === 1 ? "y" : "ies"}
                  {repo.enabled ? (
                    <Badge variant={repo.write ? "secondary" : "outline"}>
                      {repo.write ? "read + write" : "read only"}
                    </Badge>
                  ) : (
                    <Badge variant="outline">disabled</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Follows durable deletion until the project row disappears. */
function DeletionProgress({
  projectId,
  initialObjects,
}: {
  readonly projectId: string;
  readonly initialObjects: number;
}) {
  const org = useOrg();
  const [tick, setTick] = useState(0);
  const storage = useResource(`deleting:${projectId}:${tick}`, (signal) =>
    getStorage(projectId, signal),
  );
  const done =
    storage.status === "error" && storage.error instanceof ApiError && storage.error.status === 404;
  const remaining = storage.data?.objects ?? initialObjects;

  useEffect(() => {
    if (done) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), 3000);

    return () => window.clearTimeout(timer);
  }, [done, tick]);

  return (
    <Card role="status">
      <CardHeader>
        <CardTitle>{done ? "Project deleted" : "Deleting project…"}</CardTitle>
        <CardDescription>
          {done
            ? "All artifacts were removed."
            : `Credentials no longer work. Removing artifacts in the background: ${remaining} left.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {storage.status === "error" && !done ? <ErrorState error={storage.error} /> : null}
        <Progress
          value={
            done
              ? 100
              : initialObjects === 0
                ? 50
                : Math.max(5, ((initialObjects - remaining) / initialObjects) * 100)
          }
          aria-label="Deletion progress"
        />
        <Button
          variant="outline"
          className="self-start"
          onClick={() => navigate(orgPath(org, "/projects"))}
        >
          Back to projects
        </Button>
      </CardContent>
    </Card>
  );
}

export function ProjectPage({ projectId }: { readonly projectId: string }) {
  const org = useOrg();
  const permissions = useOrgPermissions();
  const { params } = splitLocation(useLocation());
  const tab: Tab = tabs.find((item) => item === params.get("tab")) ?? "settings";
  const project = useResource(`project:${projectId}`, (signal) => getProject(projectId, signal));
  const storage = useResource(`storage:${projectId}`, (signal) => getStorage(projectId, signal));
  // Listing grants requires `grant`, which project admins hold through their grant
  // and org admins through their role; it doubles as the project-admin signal.
  const admin = useResource(`grants:${projectId}`, (signal) => listGrants(projectId, signal));
  const [deleted, setDeleted] = useState<number>();
  const base = orgPath(org, `/projects/${encodeURIComponent(projectId)}`);

  if (deleted !== undefined || storage.data?.deletionRequestedAt)
    return (
      <>
        <PageHeader eyebrow="Project" title={project.data?.name ?? "Project"} />
        <DeletionProgress
          projectId={projectId}
          initialObjects={deleted ?? storage.data?.objects ?? 0}
        />
      </>
    );

  if (project.status === "error")
    return <ErrorState error={project.error} onRetry={project.reload} />;

  if (!project.data) return <LoadingRows rows={5} />;
  const data = project.data;
  const quota = storage.data?.limits.quotaBytes ?? 0;
  const over = storage.data !== undefined && quota > 0 && storage.data.bytes >= quota;
  const near =
    storage.data !== undefined && quota > 0 && !over && storage.data.bytes >= quota * 0.8;
  const projectAdmin = admin.status === "ready";
  const canUpdate = permissions.can("project", "update") || projectAdmin;
  const reload = () => {
    project.reload();
    storage.reload();
  };

  return (
    <>
      <a
        href={href(orgPath(org, "/projects"))}
        className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Projects
      </a>
      <PageHeader
        eyebrow="Project"
        title={data.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs">{data.slug}</code>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-xs">ID {data.id}</span>
            <CopyButton text={data.id} label="Copy project ID" />
          </span>
        }
        actions={
          data.archivedAt ? (
            <Badge variant="outline">
              <Archive data-icon="inline-start" />
              Archived
            </Badge>
          ) : null
        }
      />
      {over || near ? (
        <Alert variant={over ? "destructive" : "default"}>
          <AlertTriangle />
          <AlertTitle>{over ? "Over quota" : "Approaching quota"}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>
              {formatBytes(storage.data?.bytes ?? 0)} of {formatBytes(quota)} used.{" "}
              {over
                ? "New uploads are rejected until usage drops; reads keep working."
                : "Uploads are rejected once the quota is reached."}
            </span>
            <Progress
              value={Math.min(100, ((storage.data?.bytes ?? 0) / quota) * 100)}
              aria-label="Quota used"
            />
          </AlertDescription>
        </Alert>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(value) => navigate(`${base}?tab=${String(value)}`, { replace: true })}
      >
        <TabsList aria-label="Project sections">
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="repositories">Repositories</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "settings" ? (
        <SettingsTab
          key={`${data.id}:${data.name}:${data.slug}:${data.retentionDays}:${data.maxArtifactBytes}`}
          project={data}
          storage={storage.data}
          canUpdate={canUpdate}
          canDelete={permissions.can("project", "delete") || projectAdmin}
          onChanged={reload}
          onDeleted={() => setDeleted(storage.data?.objects ?? 0)}
        />
      ) : tab === "access" ? (
        projectAdmin ? (
          <AccessTab projectId={data.id} archived={data.archivedAt !== null} />
        ) : admin.status === "error" ? (
          <EmptyState
            title="Access is managed by project admins"
            description="Ask a project or organization admin to change who can use this project."
          />
        ) : (
          <LoadingRows />
        )
      ) : tab === "storage" ? (
        storage.status === "error" ? (
          <ErrorState error={storage.error} onRetry={storage.reload} />
        ) : storage.data ? (
          <StorageTab
            projectId={data.id}
            storage={storage.data}
            canPurge={canUpdate}
            onChanged={storage.reload}
          />
        ) : (
          <LoadingRows />
        )
      ) : (
        <Repositories projectId={data.id} />
      )}
    </>
  );
}
