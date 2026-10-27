import { useState } from "react";
import { Link2, MailPlus, Trash2, UserMinus, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
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
  CodeBlock,
  EmptyState,
  ErrorState,
  LoadingRows,
  PageHeader,
  formatDate,
} from "../components/common.tsx";
import { ConfirmDialog, NativeSelect, useAction } from "../components/forms.tsx";
import { authClient } from "../lib/auth-client.ts";
import {
  builtInRoleNames,
  cancelInvitation,
  invitationLink,
  invite,
  listInvitations,
  listMembers,
  listRoles,
  removeMember,
  updateMemberRole,
  type Invitation,
  type Member,
} from "../lib/org-admin.ts";
import { useOrg } from "../lib/org.tsx";
import { useOrgPermissions } from "../lib/use-org-permissions.ts";
import { useResource } from "../lib/use-resource.ts";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";

/** Roles an inviter may assign. Owner is only reachable through ownership transfer. */
function useAssignableRoles() {
  const org = useOrg();
  const custom = useResource(`roles:${org.id}`, (signal) =>
    listRoles(org.id, signal).catch(() => []),
  );

  return [
    ...builtInRoleNames.filter((role) => role !== "owner"),
    ...(custom.data ?? []).map((role) => role.role),
  ];
}

function InviteDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInvited: () => void;
}) {
  const org = useOrg();
  const roles = useAssignableRoles();
  const [by, setBy] = useState<"email" | "github">("email");
  const [who, setWho] = useState("");
  const [role, setRole] = useState("member");
  const [result, setResult] = useState<{ url: string; delivered: boolean }>();
  const action = useAction();

  function close(next: boolean) {
    if (!next) {
      setWho("");
      setResult(undefined);
      action.clear();
    }
    onOpenChange(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const response = await action.run(() =>
      invite({
        organizationId: org.id,
        role,
        ...(by === "email"
          ? { email: who.trim() }
          : { githubUsername: who.trim().replace(/^@/, "") }),
      }),
    );

    if (response) {
      setResult({ url: response.url, delivered: response.delivered });
      onInvited();
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite to {org.name}</DialogTitle>
          <DialogDescription>
            Invitations expire after 48 hours and can be used once by the invited person.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              {result.delivered
                ? "Invitation sent by email. You can also share this link:"
                : "Email isn't available, so share this link with them directly:"}
            </p>
            <CodeBlock label="Invitation link" code={result.url} />
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
            <Tabs value={by} onValueChange={(value) => setBy(value as "email" | "github")}>
              <TabsList aria-label="Invite by">
                <TabsTrigger value="email">Email</TabsTrigger>
                <TabsTrigger value="github">GitHub username</TabsTrigger>
              </TabsList>
            </Tabs>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-who">
                  {by === "email" ? "Email address" : "GitHub username"}
                </FieldLabel>
                <Input
                  id="invite-who"
                  required
                  type={by === "email" ? "email" : "text"}
                  autoComplete="off"
                  value={who}
                  onChange={(event) => setWho(event.target.value)}
                />
                {by === "github" ? (
                  <FieldDescription>
                    They must have signed in to this instance once.
                  </FieldDescription>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="invite-role">Role</FieldLabel>
                <NativeSelect
                  id="invite-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                >
                  {roles.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  You can only grant permissions you have yourself.
                </FieldDescription>
              </Field>
            </FieldGroup>
            {action.error === undefined ? null : <ErrorState error={action.error} />}
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={action.busy || !who.trim()}>
                {action.busy ? "Inviting…" : "Send invitation"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  member,
  self,
  canUpdate,
  canRemove,
  roles,
  onChanged,
}: {
  readonly member: Member;
  readonly self: boolean;
  readonly canUpdate: boolean;
  readonly canRemove: boolean;
  readonly roles: ReadonlyArray<string>;
  readonly onChanged: () => void;
}) {
  const org = useOrg();
  const [removing, setRemoving] = useState(false);
  const action = useAction();
  const owner = member.role.split(",").includes("owner");
  const options = roles.includes(member.role) ? roles : [member.role, ...roles];

  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-3">
          <Avatar className="size-7">
            {member.user.image ? <AvatarImage src={member.user.image} alt="" /> : null}
            <AvatarFallback className="text-[11px]">{initials(member.user.name)}</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">
              {member.user.name}{" "}
              {self ? (
                <span className="text-xs font-normal text-muted-foreground">(you)</span>
              ) : null}
            </span>
            <span className="truncate text-xs text-muted-foreground">{member.user.email}</span>
          </span>
        </span>
      </TableCell>
      <TableCell className="w-44">
        {canUpdate && !owner && !self ? (
          <NativeSelect
            aria-label={`Role for ${member.user.name}`}
            value={member.role}
            disabled={action.busy}
            onChange={(event) => {
              const role = event.target.value;
              void action.run(() => updateMemberRole(org.id, member.id, role)).then(onChanged);
            }}
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Badge variant={owner ? "default" : "secondary"}>{member.role}</Badge>
        )}
        {action.error === undefined ? null : (
          <p role="alert" className="mt-1 text-xs text-destructive">
            Role change refused.
          </p>
        )}
      </TableCell>
      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
        {formatDate(member.createdAt)}
      </TableCell>
      <TableCell className="w-12 text-right">
        {canRemove && !owner && !self ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${member.user.name}`}
              onClick={() => setRemoving(true)}
            >
              <UserMinus />
            </Button>
            <ConfirmDialog
              open={removing}
              onOpenChange={setRemoving}
              title={`Remove ${member.user.name}?`}
              description="They lose access to this organization's projects immediately. Group memberships and direct project grants are removed with them."
              confirmLabel="Remove member"
              destructive
              onConfirm={async () => {
                await removeMember(org.id, member.id);
                onChanged();
              }}
            />
          </>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function InvitationRow({
  invitation,
  canCancel,
  onChanged,
}: {
  readonly invitation: Invitation;
  readonly canCancel: boolean;
  readonly onChanged: () => void;
}) {
  const [link, setLink] = useState<string>();
  const action = useAction();

  return (
    <TableRow>
      <TableCell className="font-medium">{invitation.email}</TableCell>
      <TableCell>
        <Badge variant="outline">{invitation.role}</Badge>
      </TableCell>
      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
        {formatDate(invitation.expiresAt)}
      </TableCell>
      <TableCell className="text-right">
        <span className="inline-flex gap-1">
          {canCancel ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Copy invitation link for ${invitation.email}`}
                disabled={action.busy}
                onClick={() =>
                  void action
                    .run(() => invitationLink(invitation.id))
                    .then((value) => value && setLink(value.url))
                }
              >
                <Link2 />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Cancel invitation for ${invitation.email}`}
                disabled={action.busy}
                onClick={() =>
                  void action.run(() => cancelInvitation(invitation.id)).then(onChanged)
                }
              >
                <Trash2 />
              </Button>
            </>
          ) : null}
        </span>
        {link ? (
          <div className="mt-2 text-left">
            <CodeBlock label="Invitation link" code={link} />
          </div>
        ) : null}
        {action.error === undefined ? null : (
          <div className="mt-2 text-left">
            <ErrorState error={action.error} />
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function MembersPage() {
  const org = useOrg();
  const permissions = useOrgPermissions();
  const session = authClient.useSession();
  const roles = useAssignableRoles();
  const [inviting, setInviting] = useState(false);
  const members = useResource(`members:${org.id}`, (signal) => listMembers(org.id, signal));
  const invitations = useResource(
    permissions.can("invitation", "create") ? `invitations:${org.id}` : null,
    (signal) => listInvitations(org.id, signal),
  );
  const pending = (invitations.data ?? []).filter((invitation) => invitation.status === "pending");

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Members"
        description="People in this organization and their roles. Project access is granted separately on each project."
        actions={
          permissions.can("invitation", "create") ? (
            <Button onClick={() => setInviting(true)}>
              <MailPlus data-icon="inline-start" />
              Invite people
            </Button>
          ) : null
        }
      />
      <InviteDialog open={inviting} onOpenChange={setInviting} onInvited={invitations.reload} />
      <Card>
        <CardHeader>
          <CardTitle>
            {members.data
              ? `${members.data.total} member${members.data.total === 1 ? "" : "s"}`
              : "Members"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {members.status === "error" ? (
            <ErrorState error={members.error} onRetry={members.reload} />
          ) : !members.data ? (
            <LoadingRows />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden sm:table-cell">Joined</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data.members.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    self={member.userId === session.data?.user.id}
                    canUpdate={permissions.can("member", "update")}
                    canRemove={permissions.can("member", "delete")}
                    roles={roles}
                    onChanged={members.reload}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {permissions.can("invitation", "create") ? (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
            <CardDescription>
              Copy a fresh link if an email didn't arrive, or cancel an invitation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invitations.status === "error" ? (
              <ErrorState error={invitations.error} onRetry={invitations.reload} />
            ) : !invitations.data ? (
              <LoadingRows rows={2} />
            ) : pending.length === 0 ? (
              <EmptyState icon={<Users />} title="No pending invitations" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="hidden sm:table-cell">Expires</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map((invitation) => (
                    <InvitationRow
                      key={invitation.id}
                      invitation={invitation}
                      canCancel={permissions.can("invitation", "cancel")}
                      onChanged={invitations.reload}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
