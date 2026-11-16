import { useState } from "react";
import { PurgeFilter, PurgeReport } from "@repo/shared";
import { Schema } from "effect";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@repo/ui/components/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@repo/ui/components/card";

import { ConfirmDialog, NativeSelect } from "../components/forms.tsx";
import { ErrorState } from "../components/common.tsx";
import { useOrg } from "../lib/org.tsx";
import { listProjects } from "../lib/projects.ts";
import { useResource } from "../lib/use-resource.ts";

const filters = [
  "hash",
  "credentialId",
  "userId",
  "provider",
  "repositoryId",
  "ref",
  "jobWorkflowRef",
  "runId",
  "commitSha",
  "since",
  "until",
] as const;
const labels = {
  hash: "Artifact hash",
  credentialId: "Credential ID",
  userId: "Developer user ID",
  provider: "OIDC provider",
  repositoryId: "Repository ID",
  ref: "Git ref",
  jobWorkflowRef: "Workflow reference",
  runId: "Run ID",
  commitSha: "Commit SHA",
  since: "Uploaded since (ISO timestamp)",
  until: "Uploaded until (ISO timestamp)",
};
export function PurgePage() {
  const org = useOrg();
  return <OrgPurgePage key={org.id} />;
}

function OrgPurgePage() {
  const org = useOrg();
  const projects = useResource(`purge-projects:${org.id}`, (signal) =>
    listProjects(org.id, signal),
  );
  const [confirming, setConfirming] = useState(false);
  const [project, setProject] = useState("");
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [job, setJob] = useState<{ project: string; report: PurgeReport }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selected = projects.data?.items.find((item) => item.id === project);
  async function request(action: "preview" | "refresh" | "confirm") {
    setBusy(true);
    setMessage("");
    try {
      const selectedProject = action === "preview" ? project : job?.project;
      if (
        projects.status !== "ready" ||
        !selectedProject ||
        !projects.data.items.some((item) => item.id === selectedProject)
      )
        throw new Error("Select a project in the current organization.");
      const body =
        action === "preview"
          ? Schema.decodeUnknownSync(PurgeFilter)(
              Object.fromEntries(Object.entries(filter).filter(([, v]) => v)),
            )
          : undefined;
      const suffix =
        action === "preview"
          ? ""
          : `/${encodeURIComponent(job!.report.id)}${action === "confirm" ? "/confirm" : ""}`;
      const response = await fetch(
        `/projects/${encodeURIComponent(selectedProject)}/purges${suffix}`,
        {
          method: action === "refresh" ? "GET" : "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Sign in with a fresh session before managing artifacts."
            : response.status === 403
              ? "Project admin access and any required passkey check are needed."
              : "Request failed. Refresh the job or create a new preview with a valid filter.",
        );
      setJob({
        project: selectedProject,
        report: Schema.decodeUnknownSync(PurgeReport)(await response.json()),
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to reach the server.");
      if (action === "confirm") throw error;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-6" aria-labelledby="purge-title">
      <h1 id="purge-title" className="text-3xl font-semibold tracking-tight">
        Purge artifacts
      </h1>
      <p className="text-sm text-muted-foreground">
        Find artifacts from a compromised build. Revoke the affected credentials first, review the
        preview, then confirm deletion.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Select artifacts</CardTitle>
          <CardDescription>
            All filled filters must match. A preview never deletes artifacts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void request("preview");
            }}
            className="flex flex-col gap-6"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="purge-project">Project</FieldLabel>
                <NativeSelect
                  id="purge-project"
                  required
                  disabled={busy || projects.status !== "ready"}
                  value={project}
                  onChange={(e) => {
                    setProject(e.target.value);
                    setJob(undefined);
                    setConfirming(false);
                  }}
                >
                  <option value="">Select a project in {org.name}</option>
                  {projects.data?.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.slug})
                    </option>
                  ))}
                </NativeSelect>
                {projects.status === "error" && (
                  <ErrorState error={projects.error} onRetry={projects.reload} />
                )}
              </Field>
              {filters.map((key) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`purge-${key}`}>{labels[key]}</FieldLabel>
                  <Input
                    id={`purge-${key}`}
                    value={filter[key] ?? ""}
                    onChange={(e) => {
                      setFilter({ ...filter, [key]: e.target.value });
                      setJob(undefined);
                    }}
                  />
                </Field>
              ))}
              <FieldDescription>
                Use at least one filter. Jobs over 1,000 matching artifacts require a narrower
                filter. Preview confirmation expires after 15 minutes.
              </FieldDescription>
            </FieldGroup>
            <Button
              type="submit"
              disabled={
                busy ||
                projects.status !== "ready" ||
                !selected ||
                !Object.values(filter).some(Boolean)
              }
            >
              Preview purge
            </Button>
          </form>
        </CardContent>
      </Card>
      {job && selected && confirming && (
        <ConfirmDialog
          key={job.report.id}
          open={confirming}
          onOpenChange={setConfirming}
          title="Permanently delete artifacts?"
          description={`Delete ${job.report.count} artifacts (${job.report.bytes.toLocaleString()} bytes) from ${selected.name} in ${org.name}. This cannot be undone.`}
          typed={selected.slug}
          destructive
          confirmLabel="Permanently delete artifacts"
          onConfirm={() => request("confirm")}
        />
      )}
      {message && (
        <p role="alert" className="text-sm">
          {message}
        </p>
      )}
      {job && selected && (
        <Card>
          <CardHeader>
            <CardTitle>Purge preview</CardTitle>
            <CardDescription>
              Job {job.report.id} · {job.report.state}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p role="status">
              {job.report.count} artifacts · {job.report.bytes.toLocaleString()} bytes matched.{" "}
              {job.report.removed} removed or already absent.
            </p>
            <p className="text-sm text-muted-foreground">
              Deletion is permanent. Project uploads pause while the job runs. New uploads after the
              preview and changed object versions are excluded.
            </p>
            {job.report.state === "too_large" && (
              <p role="alert">Narrow the filter and create another preview.</p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" disabled={busy} onClick={() => void request("refresh")}>
                Refresh job
              </Button>
              <Button
                variant="destructive"
                disabled={
                  busy || projects.status !== "ready" || !selected || job.report.state !== "ready"
                }
                onClick={() => setConfirming(true)}
              >
                Confirm permanent deletion
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
