import { FolderGit2, GitBranch, Terminal } from "lucide-react";
import { ProjectList } from "@repo/shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import {
  CodeBlock,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
} from "../components/common.tsx";
import { api } from "../lib/api.ts";
import { orgPath, useOrg } from "../lib/org.tsx";
import { href } from "../lib/router.tsx";
import { Button } from "@repo/ui/components/button";
import { useResource } from "../lib/use-resource.ts";

export function OverviewPage() {
  const org = useOrg();
  const origin = window.location.origin;

  const projects = useResource(`projects:${org.id}`, (signal) =>
    api(`/orgs/${encodeURIComponent(org.id)}/projects?limit=100`, { schema: ProjectList, signal }),
  );

  const project = projects.data?.items[0]?.id ?? "<project-id>";
  const local = `tcache login --api ${origin}\ntcache link --team ${org.slug} --project ${project}\ntcache exec -- turbo run build`;
  const ci = `permissions:\n  contents: read\n  id-token: write\nsteps:\n  - uses: StvyaSharma/turborepo-remote-cache-api/packages/action@<reviewed-full-commit-sha>\n    with:\n      api: ${origin}\n      team: ${org.id}\n      project: ${project}\n  - run: bunx turbo run build`;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={org.name}
        description="Connect workspaces to this organization's cache and see its projects at a glance."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Connect a workspace</CardTitle>
            <CardDescription>
              Every cache request is scoped to this organization. Its slug is your{" "}
              <code className="font-mono">TURBO_TEAM</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2">
              <code className="min-w-0 font-mono text-xs break-all">TURBO_API={origin}</code>
              <CopyButton text={origin} label="Copy cache URL" />
            </div>
            <Tabs defaultValue="local">
              <TabsList aria-label="Connection environment">
                <TabsTrigger value="local">
                  <Terminal data-icon="inline-start" />
                  Laptop
                </TabsTrigger>
                <TabsTrigger value="ci">
                  <GitBranch data-icon="inline-start" />
                  GitHub Actions
                </TabsTrigger>
              </TabsList>
              <TabsContent value="local" className="pt-4">
                <CodeBlock code={local} label="Laptop setup commands" />
              </TabsContent>
              <TabsContent value="ci" className="pt-4">
                <CodeBlock code={ci} label="GitHub Actions steps" />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Projects</CardTitle>
            <CardDescription>Each project is an isolated cache namespace.</CardDescription>
          </CardHeader>
          <CardContent>
            {projects.status === "error" ? (
              <ErrorState error={projects.error} onRetry={projects.reload} />
            ) : projects.data === undefined ? (
              <LoadingRows rows={3} />
            ) : projects.data.items.length === 0 ? (
              <EmptyState
                icon={<FolderGit2 />}
                title="No projects yet"
                description="Create a project to start caching builds."
                action={
                  <Button
                    render={<a href={href(orgPath(org, "/onboarding"))} />}
                    nativeButton={false}
                  >
                    Set up your first project
                  </Button>
                }
              />
            ) : (
              <ul className="flex flex-col divide-y">
                {projects.data.items.map((project) => (
                  <li key={project.id} className="flex items-center justify-between gap-3 py-2.5">
                    <a
                      href={href(orgPath(org, `/projects/${encodeURIComponent(project.id)}`))}
                      className="min-w-0 truncate text-sm font-medium hover:underline"
                    >
                      {project.name}
                    </a>
                    <code className="truncate font-mono text-xs text-muted-foreground">
                      {project.slug}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
