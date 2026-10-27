import { useState } from "react";
import { CircleCheck, CircleX, Trash2, UserPlus } from "lucide-react";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table";
import { EmptyState, ErrorState, LoadingRows } from "../../components/common.tsx";
import { NativeSelect, useAction } from "../../components/forms.tsx";
import { accessActions, explainAccess, type AccessAction } from "../../lib/access.ts";
import { listGroupMembers, listGroups, listMembers, listRoles } from "../../lib/org-admin.ts";
import { useOrg } from "../../lib/org.tsx";
import {
  addGrant,
  listGrants,
  projectRoles,
  removeGrant,
  type ProjectRole,
} from "../../lib/projects.ts";
import { useResource } from "../../lib/use-resource.ts";

const roleLabel = (role: string) => projectRoles.find((item) => item.role === role)?.label ?? role;

export function AccessTab({
  projectId,
  archived,
}: {
  readonly projectId: string;
  readonly archived: boolean;
}) {
  const org = useOrg();
  const grants = useResource(`grants:${projectId}`, (signal) => listGrants(projectId, signal));
  const directory = useResource(`directory:${org.id}`, async (signal) => {
    const [members, groups, roles] = await Promise.all([
      listMembers(org.id, signal),
      listGroups(org.id, signal),
      listRoles(org.id, signal),
    ]);
    const groupMembers = new Map(
      await Promise.all(
        groups.map(
          async (group) =>
            [
              group.id,
              new Set(
                (await listGroupMembers(org.id, group.id, signal)).map((member) => member.userId),
              ),
            ] as const,
        ),
      ),
    );

    return { members: members.members, groups, roles, groupMembers };
  });
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState<ProjectRole>("cache:read");
  const [who, setWho] = useState("");
  const [explainAction, setExplainAction] = useState<AccessAction>("cache:write");
  const action = useAction();
  const members = directory.data?.members ?? [];
  const groups = directory.data?.groups ?? [];
  const name = (type: "user" | "team", id: string) =>
    type === "user"
      ? (members.find((member) => member.userId === id)?.user.name ?? id)
      : (groups.find((group) => group.id === id)?.name ?? id);

  async function grant(event: React.FormEvent) {
    event.preventDefault();
    const [type, id] = principal.split(":", 2) as ["user" | "team", string];
    const result = await action.run(() =>
      addGrant(projectId, { principalType: type, principalId: id, role }),
    );

    if (result !== undefined) {
      setPrincipal("");
      grants.reload();
    }
  }

  const subject = members.find((member) => member.userId === who);
  const explanation =
    subject && grants.data && directory.data
      ? explainAccess(
          {
            userId: subject.userId,
            orgRole: subject.role,
            customRoles: directory.data.roles,
            grants: grants.data,
            groupMembers: directory.data.groupMembers,
            groupNames: new Map(groups.map((group) => [group.id, group.name])),
            archived,
          },
          explainAction,
        )
      : undefined;

  if (grants.status === "error") return <ErrorState error={grants.error} onRetry={grants.reload} />;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Grants</CardTitle>
          <CardDescription>
            Who can use this project's cache. Organization owners and admins can always manage it,
            but need a grant to read or write the cache.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {!grants.data ? (
            <LoadingRows rows={2} />
          ) : grants.data.length === 0 ? (
            <EmptyState
              icon={<UserPlus />}
              title="No grants yet"
              description="Grant a member or group access below."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Who</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.data.map((item) => (
                  <TableRow key={`${item.principalType}:${item.principalId}`}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Badge variant="outline">
                          {item.principalType === "team" ? "Group" : "Member"}
                        </Badge>
                        {name(item.principalType, item.principalId)}
                      </span>
                    </TableCell>
                    <TableCell>{roleLabel(item.role)}</TableCell>
                    <TableCell className="w-12 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove grant for ${name(item.principalType, item.principalId)}`}
                        disabled={action.busy}
                        onClick={() =>
                          void action
                            .run(() => removeGrant(projectId, item.principalType, item.principalId))
                            .then(grants.reload)
                        }
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <form
            onSubmit={(event) => void grant(event)}
            className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]"
          >
            <NativeSelect
              aria-label="Member or group"
              value={principal}
              onChange={(event) => setPrincipal(event.target.value)}
            >
              <option value="">Choose a member or group…</option>
              <optgroup label="Groups">
                {groups.map((group) => (
                  <option key={group.id} value={`team:${group.id}`}>
                    {group.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Members">
                {members.map((member) => (
                  <option key={member.userId} value={`user:${member.userId}`}>
                    {member.user.name} ({member.user.email})
                  </option>
                ))}
              </optgroup>
            </NativeSelect>
            <NativeSelect
              aria-label="Project role"
              value={role}
              onChange={(event) => setRole(event.target.value as ProjectRole)}
            >
              {projectRoles.map((item) => (
                <option key={item.role} value={item.role}>
                  {item.label}: {item.detail.toLowerCase()}
                </option>
              ))}
            </NativeSelect>
            <Button type="submit" disabled={!principal || action.busy}>
              Grant
            </Button>
          </form>
          {action.error === undefined ? null : <ErrorState error={action.error} />}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Effective access</CardTitle>
          <CardDescription>
            Why can (or can't) someone do something here? Pick a member and an action.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Can</span>
            <NativeSelect
              aria-label="Member to explain"
              className="w-56"
              value={who}
              onChange={(event) => setWho(event.target.value)}
            >
              <option value="">choose a member…</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.user.name}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Action to explain"
              className="w-48"
              value={explainAction}
              onChange={(event) => setExplainAction(event.target.value as AccessAction)}
            >
              {accessActions.map((item) => (
                <option key={item.action} value={item.action}>
                  {item.label}
                </option>
              ))}
            </NativeSelect>
            <span>?</span>
          </div>
          {directory.status === "error" ? (
            <ErrorState error={directory.error} onRetry={directory.reload} />
          ) : null}
          {explanation && subject ? (
            <div role="status" className="flex gap-3 rounded-md border p-4 text-sm">
              {explanation.allowed ? (
                <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <CircleX className="size-5 shrink-0 text-destructive" aria-hidden="true" />
              )}
              <div className="flex flex-col gap-1">
                <p className="font-medium">
                  {subject.user.name} {explanation.allowed ? "can" : "can't"}{" "}
                  {accessActions.find((item) => item.action === explainAction)?.label}.
                </p>
                <ul className="list-disc pl-4 text-muted-foreground">
                  {explanation.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
