import { useState } from "react";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import type { TrustPolicy, TestTrustPoliciesResponse } from "@repo/shared";
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
import { Textarea } from "@repo/ui/components/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@repo/ui/components/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table";
import {
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  formatDate,
} from "../components/common.tsx";
import { ConfirmDialog, NativeSelect, useAction } from "../components/forms.tsx";
import { PolicyEditor } from "../components/oidc/PolicyEditor.tsx";
import {
  createKey,
  credentialPolicy,
  deletePolicy,
  keyAttention,
  listKeys,
  recentExchanges,
  revokeKey,
  savePolicy,
  testPolicies,
} from "../lib/credentials.ts";
import { useOrg } from "../lib/org.tsx";
import { listProjects, listTrustPolicies } from "../lib/projects.ts";
import { useResource } from "../lib/use-resource.ts";

function PolicyTester({ projectId }: { readonly projectId: string }) {
  const [sample, setSample] = useState(
    '{\n  "iss": "https://token.actions.githubusercontent.com",\n  "aud": "' +
      window.location.origin +
      '"\n}',
  );
  const [report, setReport] = useState<typeof TestTrustPoliciesResponse.Type>();
  const action = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Test sample claims</CardTitle>
        <CardDescription>
          Simulation only. Paste decoded claims, without the token. This does not verify a signature
          or issue credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Textarea
          aria-label="Sample OIDC claims"
          className="font-mono"
          rows={8}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
        />
        <Button
          className="self-start"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              setReport(undefined);
              setReport(await testPolicies(projectId, JSON.parse(sample)));
            })
          }
        >
          Test policies
        </Button>
        {action.error === undefined ? null : <ErrorState error={action.error} />}
        {report ? (
          <div className="flex flex-col gap-4" role="status">
            <p>
              {report.matched
                ? `Matches ${report.policyIds.join(", ")} · ${report.scope} · ${report.ttlSeconds}s · ${report.requireBoundTokens ? "bound tokens required" : "bearer allowed"}`
                : "No enabled, guardrail-safe policy matches."}
            </p>
            {report.policies.map((policy) => (
              <div key={policy.policyId} className="rounded-md border p-3 text-xs">
                <p className="mb-2 font-mono">
                  {policy.policyId} {policy.enabled ? "" : "(disabled)"}
                </p>
                {policy.checks.map((check) => (
                  <p key={check.claim}>
                    {check.matched ? "✓" : "✕"} {check.claim}: {check.message}
                  </p>
                ))}
                {[...policy.errors, ...policy.warnings].map((finding, i) => (
                  <p key={`${finding.code}:${i}`} className="mt-1 text-muted-foreground">
                    {finding.claim ? `${finding.claim}: ` : ""}
                    {finding.message}
                  </p>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TrustPolicies({ projectId }: { readonly projectId: string }) {
  const resource = useResource(`policies:${projectId}`, (signal) =>
    listTrustPolicies(projectId, signal),
  );
  const [editing, setEditing] = useState<typeof TrustPolicy.Type | "new">();
  const [removing, setRemoving] = useState<typeof TrustPolicy.Type>();
  const action = useAction();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle>OIDC trust policies</CardTitle>
            <CardDescription>
              Prefer short-lived, project-scoped credentials. Read only is the default.
            </CardDescription>
          </div>
          <Button onClick={() => setEditing("new")}>
            <Plus data-icon="inline-start" />
            Add policy
          </Button>
        </CardHeader>
        <CardContent>
          {resource.status === "error" ? (
            <ErrorState error={resource.error} onRetry={resource.reload} />
          ) : !resource.data ? (
            <LoadingRows />
          ) : resource.data.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck />}
              title="No trust policies"
              description="Connect a trusted CI provider to stop storing cache secrets."
            />
          ) : (
            <div className="flex flex-col divide-y">
              {resource.data.map((policy) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                  key={policy.id}
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">
                      {policy.label || policy.provider}{" "}
                      <Badge variant="outline">{policy.scope}</Badge>{" "}
                      {!policy.enabled ? <Badge variant="outline">Disabled</Badge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {policy.ttlSeconds}s · {policy.issuer}
                    </span>
                    {[...policy.errors, ...policy.warnings].map((finding, i) => (
                      <p className="text-xs text-muted-foreground" key={`${finding.code}:${i}`}>
                        {finding.message}
                      </p>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditing(policy)}>
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={action.busy}
                      onClick={() =>
                        void action
                          .run(() =>
                            savePolicy(
                              projectId,
                              { ...policy, enabled: !policy.enabled },
                              policy.id,
                            ),
                          )
                          .then(resource.reload)
                      }
                    >
                      {policy.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(policy)}>
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {action.error === undefined ? null : <ErrorState error={action.error} />}
        </CardContent>
      </Card>
      <Sheet
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{editing === "new" ? "New trust policy" : "Edit trust policy"}</SheetTitle>
            <SheetDescription>
              Server guardrails validate immutable IDs, audience, scope and trusted writes.
            </SheetDescription>
          </SheetHeader>
          <div className="p-4">
            {editing ? (
              <PolicyEditor
                key={editing === "new" ? "new" : editing.id}
                projectId={projectId}
                existing={editing === "new" ? undefined : editing}
                onCancel={() => setEditing(undefined)}
                onSaved={() => {
                  setEditing(undefined);
                  resource.reload();
                }}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title="Delete trust policy?"
        description="New exchanges will no longer match this policy. Existing credentials remain valid until expiry or revocation."
        confirmLabel="Delete policy"
        destructive
        onConfirm={async () => {
          if (removing) {
            await deletePolicy(projectId, removing.id);
            resource.reload();
          }
        }}
      />
      <PolicyTester projectId={projectId} />
    </div>
  );
}

function ApiKeys({
  projectId,
  onSwitch,
}: {
  readonly projectId: string;
  readonly onSwitch: () => void;
}) {
  const org = useOrg();
  const resource = useResource(`keys:${org.id}`, (signal) => listKeys(org.id, signal));
  const policy = useResource(`credential-policy:${org.id}`, (signal) =>
    credentialPolicy(org.id, signal),
  );
  const [secret, setSecret] = useState<string>();
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [write, setWrite] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const action = useAction();
  const disallowed = policy.data?.policy.apiKeys === "disallowed";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          API keys <Badge variant="outline">Less secure</Badge>
        </CardTitle>
        <CardDescription>
          Long-lived fallback for clients without OIDC. Secrets are shown once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Button variant="outline" className="self-start" onClick={onSwitch}>
          Switch to OIDC
        </Button>
        {disallowed ? (
          <p role="status">
            API-key creation is disabled by instance or organization policy. Existing keys are
            rejected while this policy is in effect.
          </p>
        ) : null}
        {resource.status === "error" ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : !resource.data ? (
          <LoadingRows />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Created / last use</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resource.data
                .filter((key) => key.projectId === projectId)
                .map((key) => {
                  const attention = keyAttention(key);
                  return (
                    <TableRow key={key.id}>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-2">
                          {key.name || key.id}
                          <Badge variant="outline">Less secure</Badge>
                          {!key.enabled ? <Badge variant="outline">Revoked</Badge> : null}
                          {attention.old ? <Badge variant="secondary">Old</Badge> : null}
                          {attention.unused ? <Badge variant="secondary">Unused</Badge> : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDate(key.createdAt)}
                        <br />
                        {key.lastUsedAt
                          ? formatDate(new Date(key.lastUsedAt).toISOString())
                          : "Never used"}
                      </TableCell>
                      <TableCell>
                        {key.expiresAt ? formatDate(key.expiresAt) : "No expiry"}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!key.enabled}
                          onClick={() => setRevoking(key.id)}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        )}
        {secret ? (
          <div className="flex flex-col gap-3 rounded-md border p-4">
            <p className="text-sm font-medium">Copy this key now. It will not be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="break-all font-mono text-xs">{secret}</code>
              <CopyButton text={secret} label="Copy API key" />
            </div>
            <Button className="self-start" variant="outline" onClick={() => setSecret(undefined)}>
              I've saved the key
            </Button>
          </div>
        ) : null}
        {!disallowed ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(async () => {
                setSecret(undefined);
                const created = await createKey(
                  org.id,
                  projectId,
                  name.trim(),
                  write,
                  Number(days),
                );
                setSecret(created.key);
                setName("");
                resource.reload();
              });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="key-name">Key name</FieldLabel>
                <Input
                  id="key-name"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="key-days">Expires in (days)</FieldLabel>
                <Input
                  id="key-days"
                  required
                  type="number"
                  min={1}
                  max={policy.data?.policy.maxApiKeyLifetimeDays ?? 90}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="key-scope">Scope</FieldLabel>
                <NativeSelect
                  id="key-scope"
                  value={write ? "write" : "read"}
                  onChange={(e) => setWrite(e.target.value === "write")}
                >
                  <option value="read">Read only</option>
                  <option value="write">Read and write</option>
                </NativeSelect>
              </Field>
            </FieldGroup>
            <Button className="self-start" disabled={action.busy || !name.trim()} type="submit">
              Create API key
            </Button>
          </form>
        ) : null}
        {action.error === undefined ? null : <ErrorState error={action.error} />}
      </CardContent>
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        title="Revoke API key?"
        description="The key stops working within the normal revocation cache window (up to 60 seconds)."
        confirmLabel="Revoke key"
        destructive
        onConfirm={async () => {
          if (revoking) {
            await revokeKey(revoking);
            resource.reload();
          }
        }}
      />
    </Card>
  );
}

export function CredentialsPage() {
  const org = useOrg();
  const projects = useResource(`projects:${org.id}`, (signal) => listProjects(org.id, signal));
  const [project, setProject] = useState("");
  const [section, setSection] = useState("oidc");
  const exchanges = useResource(`exchanges:${org.id}`, (signal) => recentExchanges(org.id, signal));
  const selected =
    projects.data?.items.find((item) => item.id === project)?.id ?? projects.data?.items[0]?.id;
  return (
    <>
      <PageHeader
        eyebrow="Security"
        title="Credentials"
        description="Trust CI identity with OIDC. Use API keys only when your client cannot exchange short-lived credentials."
      />
      <div className="flex flex-wrap gap-3">
        <NativeSelect
          aria-label="Credentials project"
          value={selected ?? ""}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="" disabled>
            Choose a project
          </option>
          {projects.data?.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Credential type"
          value={section}
          onChange={(e) => setSection(e.target.value)}
        >
          <option value="oidc">OIDC trust policies</option>
          <option value="keys">API keys (less secure)</option>
        </NativeSelect>
      </div>
      {projects.status === "error" ? (
        <ErrorState error={projects.error} onRetry={projects.reload} />
      ) : !projects.data ? (
        <LoadingRows />
      ) : !selected ? (
        <EmptyState
          icon={<KeyRound />}
          title="Create a project first"
          description="Credentials are scoped to exactly one project."
        />
      ) : section === "oidc" ? (
        <TrustPolicies key={selected} projectId={selected} />
      ) : (
        <ApiKeys key={selected} projectId={selected} onSwitch={() => setSection("oidc")} />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Recent exchange attempts</CardTitle>
          <CardDescription>
            Allowed and denied exchanges in the last seven days. Audit access is required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {exchanges.status === "error" ? (
            <ErrorState error={exchanges.error} onRetry={exchanges.reload} />
          ) : !exchanges.data ? (
            <LoadingRows />
          ) : exchanges.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No exchanges recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor / project</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exchanges.data.items
                  .filter((event) => !selected || event.projectId === selected)
                  .map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>{formatDate(event.ts)}</TableCell>
                      <TableCell>
                        {event.actor.display}
                        <br />
                        <code className="text-xs">{event.projectId}</code>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{event.outcome}</Badge>
                      </TableCell>
                      <TableCell>{event.reason ?? "Matched trust policy"}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
