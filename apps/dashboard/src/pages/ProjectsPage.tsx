import { useState } from "react";
import { Archive, FolderGit2, Plus, Search } from "lucide-react";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table";
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  formatDate,
} from "../components/common.tsx";
import { useAction } from "../components/forms.tsx";
import { orgPath, useOrg } from "../lib/org.tsx";
import { createProject, listProjects } from "../lib/projects.ts";
import { href, navigate } from "../lib/router.tsx";
import { useOrgPermissions } from "../lib/use-org-permissions.ts";
import { useResource } from "../lib/use-resource.ts";
import { slugify } from "./NewOrgPage.tsx";

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const org = useOrg();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string>();
  const action = useAction();
  const effectiveSlug = slug ?? slugify(name);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const project = await action.run(() =>
      createProject(org.id, { name: name.trim(), slug: effectiveSlug }),
    );

    if (project) navigate(orgPath(org, `/projects/${encodeURIComponent(project.id)}`));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            An isolated cache namespace, usually one repository.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-project-name">Name</FieldLabel>
              <Input
                id="new-project-name"
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-project-slug">Slug</FieldLabel>
              <Input
                id="new-project-slug"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxLength={64}
                className="font-mono"
                value={effectiveSlug}
                onChange={(event) => setSlug(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {action.error === undefined ? null : <ErrorState error={action.error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={action.busy || !name.trim() || !effectiveSlug}>
              {action.busy ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsPage() {
  const org = useOrg();
  const permissions = useOrgPermissions();
  const projects = useResource(`projects:${org.id}`, (signal) => listProjects(org.id, signal));
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const needle = query.trim().toLowerCase();
  const items = (projects.data?.items ?? []).filter(
    (project) =>
      !needle ||
      project.name.toLowerCase().includes(needle) ||
      project.slug.includes(needle) ||
      project.id.includes(needle),
  );

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        description="Each project is an isolated cache namespace with its own access grants, credentials and retention."
        actions={
          permissions.can("project", "create") ? (
            <Button onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" />
              New project
            </Button>
          ) : null
        }
      />
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
      <div className="relative max-w-sm">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search projects"
          placeholder="Search by name, slug or ID"
          className="pl-8"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {projects.status === "error" ? (
        <ErrorState error={projects.error} onRetry={projects.reload} />
      ) : !projects.data ? (
        <LoadingRows rows={4} />
      ) : projects.data.items.length === 0 ? (
        <EmptyState
          icon={<FolderGit2 />}
          title="No projects you can see"
          description="Projects appear here when you create one or are granted access."
          action={
            permissions.can("project", "create") ? (
              <Button render={<a href={href(orgPath(org, "/onboarding"))} />} nativeButton={false}>
                Set up your first project
              </Button>
            ) : null
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead className="hidden md:table-cell">Retention</TableHead>
              <TableHead className="hidden md:table-cell">Last activity</TableHead>
              <TableHead className="hidden sm:table-cell">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <a
                    href={href(orgPath(org, `/projects/${encodeURIComponent(project.id)}`))}
                    className="flex flex-col gap-0.5 rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="flex items-center gap-2">
                      {project.name}
                      {project.archivedAt ? (
                        <Badge variant="outline">
                          <Archive data-icon="inline-start" />
                          Archived
                        </Badge>
                      ) : null}
                    </span>
                    <code className="font-mono text-xs font-normal text-muted-foreground">
                      {project.slug}
                    </code>
                  </a>
                </TableCell>
                <TableCell className="hidden md:table-cell">{project.retentionDays} days</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  {project.lastSeenAt ? formatDate(project.lastSeenAt) : "No cache traffic yet"}
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                  {formatDate(project.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {projects.data && items.length === 0 && needle ? (
        <p className="text-sm text-muted-foreground">No projects match “{query}”.</p>
      ) : null}
    </>
  );
}
