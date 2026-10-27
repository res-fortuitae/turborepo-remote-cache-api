import { useState } from "react";
import { Schema } from "effect";
import { QuotaStatus } from "@repo/shared";
import { Alert, AlertTitle, AlertDescription } from "@repo/ui/components/alert";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@repo/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Progress } from "@repo/ui/components/progress";
import { ErrorState, LoadingRows, formatBytes } from "../../components/common.tsx";
import { NativeSelect, useAction } from "../../components/forms.tsx";
import { api } from "../../lib/api.ts";
import { useOrg } from "../../lib/org.tsx";
import { useOrgPermissions } from "../../lib/use-org-permissions.ts";
import { useResource } from "../../lib/use-resource.ts";
const report = Schema.Struct({
  ...QuotaStatus.fields,
  notifications: Schema.Array(
    Schema.Struct({ id: Schema.String, detail: Schema.String, createdAt: Schema.Number }),
  ),
});
function QuotaForm({
  path,
  limits,
  org,
}: {
  readonly path: string;
  readonly limits: typeof QuotaStatus.Type.project.limits;
  readonly org: boolean;
}) {
  const [form, setForm] = useState({
    storageBytes: String(limits.storageBytes ?? ""),
    bandwidthBytes: String(limits.bandwidthBytes ?? ""),
    requests: String(limits.requests ?? ""),
    onQuotaExceeded: limits.onQuotaExceeded,
  });
  const action = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await api(path, {
            method: "POST",
            body: {
              storageBytes: form.storageBytes ? Number(form.storageBytes) : null,
              bandwidthBytes: form.bandwidthBytes ? Number(form.bandwidthBytes) : null,
              requests: form.requests ? Number(form.requests) : null,
              onQuotaExceeded: org ? "reject" : form.onQuotaExceeded,
            },
          });
          setSaved(true);
        });
      }}
    >
      <FieldGroup>
        {(["storageBytes", "bandwidthBytes", "requests"] as const).map((name) => (
          <Field key={name}>
            <FieldLabel htmlFor={`quota-${name}`}>
              {
                {
                  storageBytes: "Storage limit (bytes; blank uses policy ceiling)",
                  bandwidthBytes: "Daily artifact bandwidth (bytes; blank is unlimited)",
                  requests: "Daily artifact requests (blank is unlimited)",
                }[name]
              }
            </FieldLabel>
            <Input
              id={`quota-${name}`}
              type="number"
              min={1}
              step={1}
              value={form[name]}
              onChange={(e) => {
                setSaved(false);
                setForm({ ...form, [name]: e.target.value });
              }}
            />
          </Field>
        ))}
        {!org ? (
          <Field>
            <FieldLabel htmlFor="quota-behavior">When storage is full</FieldLabel>
            <NativeSelect
              id="quota-behavior"
              value={form.onQuotaExceeded}
              onChange={(e) =>
                setForm({ ...form, onQuotaExceeded: e.target.value as typeof form.onQuotaExceeded })
              }
            >
              <option value="reject">Reject new uploads</option>
              <option value="evict-oldest">Evict oldest artifacts in the background</option>
            </NativeSelect>
          </Field>
        ) : null}
      </FieldGroup>
      {action.error === undefined ? null : <ErrorState error={action.error} />}
      <div className="flex gap-3">
        <Button disabled={action.busy}>Save quota settings</Button>
        <span role="status" className="self-center text-xs">
          {saved ? "Saved. Refresh usage to see the new limits." : ""}
        </span>
      </div>
    </form>
  );
}
export function QuotaCard({ projectId }: { readonly projectId: string }) {
  const org = useOrg(),
    permissions = useOrgPermissions();
  const [scope, setScope] = useState("project");
  const path =
    scope === "org"
      ? `/orgs/${encodeURIComponent(org.id)}/quotas`
      : `/projects/${encodeURIComponent(projectId)}/quotas`;
  const resource = useResource(path, (signal) => api(path, { schema: report, signal }));
  const selected = scope === "org" ? resource.data?.org : resource.data?.project;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Quotas <Badge variant="outline">Writes pause, reads continue</Badge>
        </CardTitle>
        <CardDescription>
          Storage capacity includes active upload reservations. Bandwidth and request budgets reset
          at 00:00 UTC daily. Evict-oldest applies to storage and removes artifacts until
          organization and project usage drop below 90%.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <NativeSelect
          aria-label="Quota scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="project">Project limits</option>
          <option value="org" disabled={!permissions.can("project", "update")}>
            Organization limits
          </option>
        </NativeSelect>
        {resource.status === "error" ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : !resource.data || !selected ? (
          <LoadingRows />
        ) : (
          <>
            {resource.data.overLimit ? (
              <Alert variant="destructive">
                <AlertTitle>Uploads paused</AlertTitle>
                <AlertDescription>
                  A quota is reached or eviction is running. Cached artifacts remain readable.
                </AlertDescription>
              </Alert>
            ) : selected.limits.storageBytes &&
              selected.usage.storageBytes >= selected.limits.storageBytes * 0.8 ? (
              <Alert>
                <AlertTitle>Storage is at least 80% full</AlertTitle>
                <AlertDescription>
                  Free space, adjust the quota or enable background eviction before reaching
                  capacity.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                {formatBytes(selected.usage.storageBytes)} stored /{" "}
                {formatBytes(selected.limits.storageBytes ?? 0)} limit ·{" "}
                {formatBytes(selected.usage.reservedBytes)} reserved
              </p>
              <Progress
                aria-label="Storage quota used"
                value={
                  selected.limits.storageBytes
                    ? Math.min(
                        100,
                        (selected.usage.storageBytes / selected.limits.storageBytes) * 100,
                      )
                    : 0
                }
              />
              <p className="text-xs text-muted-foreground">
                Today: {selected.usage.requests} artifact requests;{" "}
                {formatBytes(selected.usage.bandwidthBytes)} transferred.
              </p>
            </div>
            {resource.data.eviction && scope === "project" ? (
              <p role="status" className="text-sm">
                Eviction: {resource.data.eviction.state} · {resource.data.eviction.removed}{" "}
                artifacts / {formatBytes(resource.data.eviction.removedBytes)} removed.
              </p>
            ) : null}
            <Button variant="outline" className="self-start" onClick={resource.reload}>
              Refresh usage
            </Button>
            <QuotaForm
              key={`${path}:${JSON.stringify(selected.limits)}`}
              path={path}
              limits={selected.limits}
              org={scope === "org"}
            />
            {resource.data.notifications.length ? (
              <div>
                <h3 className="mb-2 text-sm font-medium">Quota alerts</h3>
                <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
                  {resource.data.notifications.map((item) => (
                    <li key={item.id}>{item.detail}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
