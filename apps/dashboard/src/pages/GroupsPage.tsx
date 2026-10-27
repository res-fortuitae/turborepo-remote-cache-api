import { useState } from "react";
import { Pencil, Plus, Trash2, UserMinus, UsersRound } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { cn } from "@repo/ui/lib/utils";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "../components/common.tsx";
import { ConfirmDialog, NativeSelect, useAction } from "../components/forms.tsx";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  listGroupMembers,
  listGroups,
  listMembers,
  removeGroupMember,
  renameGroup,
  type Group,
  type Member,
} from "../lib/org-admin.ts";
import { useOrg } from "../lib/org.tsx";
import { useOrgPermissions } from "../lib/use-org-permissions.ts";
import { useResource } from "../lib/use-resource.ts";

function GroupDetail({
  group,
  members,
  canEdit,
  canDelete,
  onChanged,
}: {
  readonly group: Group;
  readonly members: ReadonlyArray<Member>;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly onChanged: () => void;
}) {
  const org = useOrg();
  const groupMembers = useResource(`group-members:${group.id}`, (signal) =>
    listGroupMembers(org.id, group.id, signal),
  );
  const [name, setName] = useState<string>();
  const [adding, setAdding] = useState("");
  const [deleting, setDeleting] = useState(false);
  const action = useAction();
  const inGroup = new Set((groupMembers.data ?? []).map((member) => member.userId));
  const candidates = members.filter((member) => !inGroup.has(member.userId));
  const byUser = new Map(members.map((member) => [member.userId, member]));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        {name === undefined ? (
          <div className="flex flex-col gap-1">
            <CardTitle>{group.name}</CardTitle>
            <CardDescription>
              Grant this group a project role to give all its members access. Group ID{" "}
              <code className="font-mono">{group.id}</code>
            </CardDescription>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void action
                .run(() => renameGroup(org.id, group.id, name.trim()))
                .then((value) => {
                  if (value) {
                    setName(undefined);
                    onChanged();
                  }
                });
            }}
          >
            <Input
              aria-label="Group name"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={action.busy || !name.trim()}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setName(undefined)}>
              Cancel
            </Button>
          </form>
        )}
        <span className="flex gap-1">
          {canEdit && name === undefined ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Rename group"
              onClick={() => setName(group.name)}
            >
              <Pencil />
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete group"
              onClick={() => setDeleting(true)}
            >
              <Trash2 />
            </Button>
          ) : null}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {groupMembers.status === "error" ? (
          <ErrorState error={groupMembers.error} onRetry={groupMembers.reload} />
        ) : !groupMembers.data ? (
          <LoadingRows rows={2} />
        ) : groupMembers.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {groupMembers.data.map((entry) => {
              const member = byUser.get(entry.userId);

              return (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {member?.user.name ?? entry.userId}{" "}
                    <span className="text-xs text-muted-foreground">{member?.user.email}</span>
                  </span>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${member?.user.name ?? entry.userId} from ${group.name}`}
                      disabled={action.busy}
                      onClick={() =>
                        void action
                          .run(() => removeGroupMember(org.id, group.id, entry.userId))
                          .then(groupMembers.reload)
                      }
                    >
                      <UserMinus />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && candidates.length > 0 ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void action
                .run(() => addGroupMember(org.id, group.id, adding))
                .then(() => {
                  setAdding("");
                  groupMembers.reload();
                });
            }}
          >
            <NativeSelect
              aria-label="Member to add"
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
            >
              <option value="">Add a member…</option>
              {candidates.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.user.name} ({member.user.email})
                </option>
              ))}
            </NativeSelect>
            <Button type="submit" variant="outline" disabled={!adding || action.busy}>
              Add
            </Button>
          </form>
        ) : null}
        {action.error === undefined ? null : <ErrorState error={action.error} />}
      </CardContent>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${group.name}?`}
        description="Members keep their organization membership, but lose any project access granted through this group."
        confirmLabel="Delete group"
        destructive
        onConfirm={async () => {
          await deleteGroup(org.id, group.id);
          onChanged();
        }}
      />
    </Card>
  );
}

export function GroupsPage() {
  const org = useOrg();
  const permissions = useOrgPermissions();
  const groups = useResource(`groups:${org.id}`, (signal) => listGroups(org.id, signal));
  const members = useResource(`members:${org.id}`, (signal) => listMembers(org.id, signal));
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState("");
  const action = useAction();
  const list = groups.data ?? [];
  const current = list.find((group) => group.id === selected) ?? list[0];

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Groups"
        description="Optional sets of members. Grant a group a project role instead of granting each person."
      />
      {permissions.can("team", "create") ? (
        <form
          className="flex max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void action
              .run(() => createGroup(org.id, name.trim()))
              .then((group) => {
                if (group) {
                  setName("");
                  setSelected(group.id);
                  groups.reload();
                }
              });
          }}
        >
          <Input
            aria-label="New group name"
            placeholder="Platform team"
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={action.busy || !name.trim()}>
            <Plus data-icon="inline-start" />
            Create group
          </Button>
        </form>
      ) : null}
      {action.error === undefined ? null : <ErrorState error={action.error} />}
      {groups.status === "error" ? (
        <ErrorState error={groups.error} onRetry={groups.reload} />
      ) : !groups.data ? (
        <LoadingRows />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<UsersRound />}
          title="No groups"
          description="Groups are optional. Create one when several people need the same project access."
        />
      ) : (
        <div className="grid items-start gap-6 md:grid-cols-[14rem_1fr]">
          <nav aria-label="Groups" className="flex flex-col gap-1">
            {list.map((group) => (
              <button
                key={group.id}
                type="button"
                aria-current={group.id === current?.id ? "true" : undefined}
                onClick={() => setSelected(group.id)}
                className={cn(
                  "rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  group.id === current?.id && "bg-muted font-medium text-foreground",
                )}
              >
                {group.name}
              </button>
            ))}
          </nav>
          {current ? (
            <GroupDetail
              key={current.id}
              group={current}
              members={members.data?.members ?? []}
              canEdit={permissions.can("team", "update")}
              canDelete={permissions.can("team", "delete")}
              onChanged={() => {
                setSelected(undefined);
                groups.reload();
              }}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
