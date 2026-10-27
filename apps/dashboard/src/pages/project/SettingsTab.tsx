import { SigningCard } from "./SigningCard.tsx";
import { useState } from "react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import type { Project, ProjectStorage } from "@repo/shared";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { ErrorState, formatBytes } from "../../components/common.tsx";
import { ConfirmDialog, useAction } from "../../components/forms.tsx";
import { deleteProject, updateProject } from "../../lib/projects.ts";

const MB = 1024 * 1024;

export function SettingsTab({
  project,
  storage,
  canUpdate,
  canDelete,
  onChanged,
  onDeleted,
}: {
  readonly project: typeof Project.Type;
  readonly storage: typeof ProjectStorage.Type | undefined;
  readonly canUpdate: boolean;
  readonly canDelete: boolean;
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
}) {
  const [form, setForm] = useState({
    name: project.name,
    slug: project.slug,
    description: project.description ?? "",
    retentionDays: String(project.retentionDays),
    maxArtifactMb: String(project.maxArtifactBytes / MB),
  });
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const archive = useAction();
  const limits = storage?.limits;
  const retention = Number(form.retentionDays);
  const maxBytes = Math.round(Number(form.maxArtifactMb) * MB);
  const valid =
    form.name.trim() !== "" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug) &&
    Number.isInteger(retention) &&
    retention >= 1 &&
    (!limits || retention <= limits.maxRetentionDays) &&
    Number.isFinite(maxBytes) &&
    maxBytes >= 1 &&
    (!limits || maxBytes <= limits.maxArtifactBytes);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaved(false);
    const result = await action.run(() =>
      updateProject(project.id, {
        name: form.name.trim(),
        slug: form.slug,
        description: form.description.trim() || null,
        retentionDays: retention,
        maxArtifactBytes: maxBytes,
      }),
    );

    if (result) {
      setSaved(true);
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {canUpdate ? <SigningCard projectId={project.id} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            Renaming changes the name and slug only. The project ID{" "}
            <code className="font-mono">{project.id}</code> never changes, so CI configuration and
            credentials keep working.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="project-settings" onSubmit={(event) => void save(event)}>
            <fieldset disabled={!canUpdate} className="flex flex-col gap-5">
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="project-name">Name</FieldLabel>
                    <Input
                      id="project-name"
                      maxLength={100}
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="project-slug">Slug</FieldLabel>
                    <Input
                      id="project-slug"
                      maxLength={64}
                      className="font-mono"
                      value={form.slug}
                      onChange={(event) => setForm({ ...form, slug: event.target.value })}
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="project-description">Description</FieldLabel>
                  <Textarea
                    id="project-description"
                    maxLength={2000}
                    rows={2}
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="project-retention">Retention (days)</FieldLabel>
                    <Input
                      id="project-retention"
                      type="number"
                      min={1}
                      max={limits?.maxRetentionDays}
                      value={form.retentionDays}
                      onChange={(event) => setForm({ ...form, retentionDays: event.target.value })}
                    />
                    <FieldDescription>
                      Artifacts not uploaded again within this window are removed.
                      {limits ? ` Instance maximum: ${limits.maxRetentionDays} days.` : ""}
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="project-max-size">Max artifact size (MiB)</FieldLabel>
                    <Input
                      id="project-max-size"
                      type="number"
                      min={1 / MB}
                      step="any"
                      max={limits ? limits.maxArtifactBytes / MB : undefined}
                      value={form.maxArtifactMb}
                      onChange={(event) => setForm({ ...form, maxArtifactMb: event.target.value })}
                    />
                    <FieldDescription>
                      {limits ? `Instance maximum: ${formatBytes(limits.maxArtifactBytes)}.` : null}
                    </FieldDescription>
                  </Field>
                </div>
              </FieldGroup>
            </fieldset>
          </form>
          {action.error === undefined ? null : (
            <div className="mt-4">
              <ErrorState error={action.error} />
            </div>
          )}
        </CardContent>
        {canUpdate ? (
          <CardFooter className="justify-end gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {saved ? "Saved." : ""}
            </span>
            <Button type="submit" form="project-settings" disabled={action.busy || !valid}>
              {action.busy ? "Saving…" : "Save changes"}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
      {canUpdate ? (
        <Card>
          <CardHeader>
            <CardTitle>{project.archivedAt ? "Archived" : "Archive"}</CardTitle>
            <CardDescription>
              {project.archivedAt
                ? "This project is read-only: cached artifacts can be restored but nothing can be uploaded."
                : "Archiving stops uploads but keeps existing artifacts readable. You can unarchive at any time."}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              variant="outline"
              disabled={archive.busy}
              onClick={() =>
                void archive
                  .run(() => updateProject(project.id, { archived: !project.archivedAt }))
                  .then(onChanged)
              }
            >
              {project.archivedAt ? (
                <ArchiveRestore data-icon="inline-start" />
              ) : (
                <Archive data-icon="inline-start" />
              )}
              {project.archivedAt ? "Unarchive project" : "Archive project"}
            </Button>
          </CardFooter>
          {archive.error === undefined ? null : (
            <CardContent>
              <ErrorState error={archive.error} />
            </CardContent>
          )}
        </Card>
      ) : null}
      {canDelete ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Delete project</CardTitle>
            <CardDescription>
              Permanently deletes every artifact, grant and trust policy. Credentials stop working
              immediately; artifact removal continues in the background.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="destructive" onClick={() => setDeleting(true)}>
              <Trash2 data-icon="inline-start" />
              Delete project
            </Button>
          </CardFooter>
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`Delete ${project.name}?`}
            description="This can't be undone. All cached artifacts are removed."
            confirmLabel="Delete permanently"
            destructive
            typed={project.id}
            onConfirm={async () => {
              await deleteProject(project.id);
              onDeleted();
            }}
          />
        </Card>
      ) : null}
    </div>
  );
}
