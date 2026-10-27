import { useState } from "react";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@repo/ui/components/card";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { Checkbox } from "@repo/ui/components/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import {
  ErrorState,
  LoadingRows,
  PageHeader,
  formatBytes,
  formatDate,
} from "../components/common.tsx";
import { ConfirmDialog, NativeSelect, useAction } from "../components/forms.tsx";
import { authClient } from "../lib/auth-client.ts";
import {
  banUser,
  elevate,
  instanceOrgs,
  instancePolicy,
  listInstanceUsers,
  revokeSessions,
  saveInstancePolicy,
  unbanUser,
  type InstanceOrg,
  type InstanceUser,
  type Policy,
} from "../lib/instance.ts";
import { href, navigate } from "../lib/router.tsx";
import { useResource } from "../lib/use-resource.ts";

const label = (name: string) =>
  name.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());

function PolicyForm({
  initial,
  ceilings,
}: {
  readonly initial: Policy;
  readonly ceilings: Policy;
}) {
  const [policy, setPolicy] = useState<Policy>({
    developerCacheWrites: false,
    oidcWriteWorkflowRefs: [],
    oidcWriteEnvironments: [],
    ...initial,
  });
  const [saved, setSaved] = useState(false);
  const action = useAction();
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          const result = await saveInstancePolicy(policy);
          setPolicy(result.policy);
          setSaved(true);
        });
      }}
    >
      <FieldGroup>
        {Object.entries(policy).map(([name, value]) => (
          <Field key={name} orientation={typeof value === "boolean" ? "horizontal" : "vertical"}>
            {typeof value === "boolean" ? (
              <>
                <Checkbox
                  id={`instance-${name}`}
                  checked={value}
                  onCheckedChange={(checked) => {
                    setPolicy({ ...policy, [name]: checked === true });
                    setSaved(false);
                  }}
                />
                <FieldLabel htmlFor={`instance-${name}`}>{label(name)}</FieldLabel>
              </>
            ) : (
              <>
                <FieldLabel htmlFor={`instance-${name}`}>{label(name)}</FieldLabel>
                {Array.isArray(value) ? (
                  <Textarea
                    id={`instance-${name}`}
                    rows={3}
                    value={value.join("\n")}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        [name]: e.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                ) : name === "apiKeys" || name === "orgCreation" ? (
                  <NativeSelect
                    id={`instance-${name}`}
                    value={String(value)}
                    onChange={(e) => setPolicy({ ...policy, [name]: e.target.value })}
                  >
                    {(name === "apiKeys"
                      ? ["allowed", "warn", "disallowed"]
                      : ["anyone", "admins"]
                    ).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    id={`instance-${name}`}
                    type={typeof value === "number" ? "number" : "text"}
                    min={typeof value === "number" ? 1 : undefined}
                    value={String(value ?? "")}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        [name]: typeof value === "number" ? Number(e.target.value) : e.target.value,
                      })
                    }
                  />
                )}
                {Array.isArray(value) ? (
                  <FieldDescription>
                    One exact value per line. Empty lists use the documented unrestricted/default
                    behavior.
                  </FieldDescription>
                ) : null}
              </>
            )}
          </Field>
        ))}
      </FieldGroup>
      <details className="text-xs">
        <summary>Deployment ceilings</summary>
        <pre className="overflow-auto">{JSON.stringify(ceilings, null, 2)}</pre>
      </details>
      <p className="text-xs text-muted-foreground">
        The server clamps settings to deployment ceilings. Enabling passkey enforcement requires a
        fresh passkey check.
      </p>
      {action.error === undefined ? null : <ErrorState error={action.error} />}
      <div className="flex items-center gap-3">
        <Button disabled={action.busy}>Save policy</Button>
        <span role="status" className="text-xs">
          {saved ? "Saved." : ""}
        </span>
      </div>
    </form>
  );
}

function InstanceSettings() {
  const resource = useResource("instance-policy", instancePolicy);
  const action = useAction();
  const session = authClient.useSession();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Administrator passkeys</CardTitle>
          <CardDescription>
            Enroll a passkey after a fresh GitHub sign-in. Verify it before privileged operations
            when enforcement is enabled. Fresh proof lasts five minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const result = await authClient.passkey.addPasskey();
                  if (result.error) throw new Error(result.error.message);
                })
              }
            >
              Enroll passkey
            </Button>
            <Button
              variant="outline"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const result = await authClient.signIn.passkey();
                  if (result.error) throw new Error(result.error.message);
                  await session.refetch();
                })
              }
            >
              Verify passkey
            </Button>
          </div>
          {action.error === undefined ? null : <ErrorState error={action.error} />}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Instance policy</CardTitle>
          <CardDescription>
            Global ceilings and security requirements. Organization policies may tighten them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {resource.status === "error" ? (
            <ErrorState error={resource.error} onRetry={resource.reload} />
          ) : !resource.data ? (
            <LoadingRows />
          ) : (
            <PolicyForm initial={resource.data.policy} ceilings={resource.data.ceilings} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Organizations({ readOnly }: { readonly readOnly: boolean }) {
  const resource = useResource("instance-orgs", instanceOrgs);
  const [selected, setSelected] = useState<InstanceOrg>();
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState("5");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organizations</CardTitle>
        <CardDescription>
          Live organization state and reconciled storage. Elevated access requires a reason, expires
          within 15 minutes, and is audited.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {resource.status === "error" ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : !resource.data ? (
          <LoadingRows />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Last cache activity</TableHead>
                <TableHead>Access</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resource.data.map((org) => (
                <TableRow key={org.id}>
                  <TableCell>
                    {org.name}
                    <p className="font-mono text-xs text-muted-foreground">{org.slug}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{org.archivedAt ? "Archived" : "Active"}</Badge>
                  </TableCell>
                  <TableCell>{org.projects}</TableCell>
                  <TableCell>{formatBytes(org.storageBytes)}</TableCell>
                  <TableCell>
                    {org.lastSeenAt
                      ? formatDate(new Date(org.lastSeenAt).toISOString())
                      : "No traffic"}
                  </TableCell>
                  <TableCell>
                    {!readOnly ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelected(org);
                          setReason("");
                        }}
                      >
                        Enter organization
                      </Button>
                    ) : (
                      "Auditor"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title={`Enter ${selected?.name ?? "organization"}?`}
        description="This grants temporary administrative access for the signed-in session. Every action remains subject to live server authorization."
        confirmLabel="Enter organization"
        onConfirm={async () => {
          if (!selected || !reason.trim()) throw new Error("Enter an access reason.");
          await elevate(selected.id, reason.trim(), Number(minutes) * 60);
          navigate(`/orgs/${encodeURIComponent(selected.slug)}/projects`);
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="elevation-reason">Reason</FieldLabel>
            <Textarea
              id="elevation-reason"
              required
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="elevation-minutes">Duration (minutes)</FieldLabel>
            <Input
              id="elevation-minutes"
              type="number"
              min={1}
              max={15}
              step={1}
              required
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
        </FieldGroup>
      </ConfirmDialog>
    </Card>
  );
}

function Users() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const resource = useResource(`instance-users:${query}:${offset}`, (signal) =>
    listInstanceUsers(query, offset, signal),
  );
  const [selected, setSelected] = useState<{
    user: InstanceUser;
    action: "ban" | "deactivate" | "unban" | "sessions";
  }>();
  const [reason, setReason] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <CardDescription>
          Ban or deactivate to prevent access and revoke sessions. Deactivation uses a permanent ban
          and can be reversed with Restore.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setQuery(search.trim());
          }}
        >
          <Input
            aria-label="Search user emails"
            placeholder="Search by email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button>Search</Button>
        </form>
        {resource.status === "error" ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : !resource.data ? (
          <LoadingRows />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resource.data.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      {user.name}
                      <p className="text-xs text-muted-foreground">{user.email}</p>
                    </TableCell>
                    <TableCell>{user.role}</TableCell>
                    <TableCell>{user.banned ? user.banReason || "Banned" : "Active"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {user.banned ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelected({ user, action: "unban" })}
                          >
                            Restore
                          </Button>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setReason("");
                                setSelected({ user, action: "ban" });
                              }}
                            >
                              Ban
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setReason("");
                                setSelected({ user, action: "deactivate" });
                              }}
                            >
                              Deactivate
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setSelected({ user, action: "sessions" })}
                            >
                              Revoke sessions
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 50))}
              >
                Previous
              </Button>
              <p className="text-xs">{resource.data.total} users</p>
              <Button
                variant="outline"
                disabled={offset + 50 >= resource.data.total}
                onClick={() => setOffset((value) => value + 50)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title={`${selected ? label(selected.action) : "Manage"} ${selected?.user.name ?? "user"}?`}
        description="This affects access across the entire instance. The server protects the last active owner and checks your live role."
        confirmLabel="Confirm"
        destructive={selected?.action !== "unban"}
        onConfirm={async () => {
          if (!selected) return;
          if (selected.action === "unban") await unbanUser(selected.user.id);
          else if (selected.action === "sessions") await revokeSessions(selected.user.id);
          else {
            if (!reason.trim()) throw new Error("Enter a reason.");
            await banUser(
              selected.user.id,
              selected.action === "deactivate" ? `Deactivated: ${reason.trim()}` : reason.trim(),
            );
          }
          resource.reload();
        }}
      >
        {selected?.action === "ban" || selected?.action === "deactivate" ? (
          <Field>
            <FieldLabel htmlFor="user-ban-reason">Reason</FieldLabel>
            <Textarea
              id="user-ban-reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}

export function InstancePage() {
  const session = authClient.useSession();
  const readOnly = session.data?.user.role === "auditor";
  const [tab, setTab] = useState("organizations");
  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Instance roles govern this console. Organization membership is separate; access to another organization requires explicit, timed elevation."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              render={<a href={href("/instance/audit")} />}
              nativeButton={false}
            >
              Global audit
            </Button>
            <Button
              variant="outline"
              render={<a href={href("/instance/analytics")} />}
              nativeButton={false}
            >
              Global analytics
            </Button>
          </div>
        }
      />
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList>
          <TabsTrigger value="organizations">Organizations</TabsTrigger>
          {!readOnly ? (
            <>
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="policy">Policy and passkeys</TabsTrigger>
            </>
          ) : null}
        </TabsList>
      </Tabs>
      {tab === "users" && !readOnly ? (
        <Users />
      ) : tab === "policy" && !readOnly ? (
        <InstanceSettings />
      ) : (
        <Organizations readOnly={readOnly} />
      )}
    </>
  );
}
