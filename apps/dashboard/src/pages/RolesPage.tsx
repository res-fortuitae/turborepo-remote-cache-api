import { useId, useState } from "react";
import { Lock, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import {
  builtInOrganizationRoles,
  organizationPermissionCatalog,
  type OrganizationPermissions,
} from "@repo/shared";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Checkbox } from "@repo/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "../components/common.tsx";
import { ConfirmDialog, useAction } from "../components/forms.tsx";
import {
  createRole,
  deleteRole,
  listRoles,
  rolePermissions,
  updateRole,
  type CustomRole,
} from "../lib/org-admin.ts";
import { useOrg } from "../lib/org.tsx";
import { useOrgPermissions } from "../lib/use-org-permissions.ts";
import { useResource } from "../lib/use-resource.ts";

const resources = Object.entries(organizationPermissionCatalog);

const count = (permissions: OrganizationPermissions) =>
  Object.values(permissions).reduce((total, actions) => total + (actions?.length ?? 0), 0);

export const togglePermission = (
  permissions: OrganizationPermissions,
  resource: string,
  action: string,
  on: boolean,
): OrganizationPermissions => {
  const current = new Set(
    (permissions as Record<string, ReadonlyArray<string> | undefined>)[resource] ?? [],
  );

  if (on) current.add(action);
  else current.delete(action);
  const next: Record<string, ReadonlyArray<string>> = { ...permissions };

  if (current.size === 0) delete next[resource];
  else next[resource] = [...current];

  return next;
};

/** A read-only or editable checklist of every org permission, grouped by resource. */
function PermissionChecklist({
  value,
  onChange,
  allowed,
}: {
  readonly value: OrganizationPermissions;
  readonly onChange?: (next: OrganizationPermissions) => void;
  readonly allowed: (resource: string, action: string) => boolean;
}) {
  // Several checklists render at once (editor and built-in role cards).
  const scope = useId();

  return (
    <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
      {resources.map(([resource, { label, actions }]) => (
        <fieldset key={resource} className="flex flex-col gap-2">
          <legend className="pb-1 text-xs font-medium">{label}</legend>
          {Object.entries(actions).map(([action, description]) => {
            const id = `${scope}-${resource}-${action}`;
            const checked = (
              (value as Record<string, ReadonlyArray<string> | undefined>)[resource] ?? []
            ).includes(action);
            const grantable = allowed(resource, action);

            return (
              <label
                key={action}
                htmlFor={id}
                className="flex items-start gap-2 text-xs text-muted-foreground"
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={!onChange || (!grantable && !checked)}
                  onCheckedChange={(on) =>
                    onChange?.(togglePermission(value, resource, action, on === true))
                  }
                />
                <span className={checked ? "text-foreground" : undefined}>
                  {description}
                  {onChange && !grantable ? (
                    <Lock
                      aria-label="You don't hold this permission"
                      className="ml-1 inline size-3"
                    />
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

function RoleEditor({
  open,
  onOpenChange,
  role,
  onSaved,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly role?: CustomRole;
  readonly onSaved: () => void;
}) {
  const org = useOrg();
  const mine = useOrgPermissions();
  const [name, setName] = useState(role?.role ?? "");
  const [permissions, setPermissions] = useState<OrganizationPermissions>(
    role ? rolePermissions(role) : {},
  );
  const action = useAction();

  async function save() {
    const saved = await action.run(() =>
      role
        ? updateRole(org.id, role.role, permissions)
        : createRole(org.id, name.trim(), permissions),
    );

    if (saved !== undefined) {
      onSaved();
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{role ? `Edit ${role.role}` : "New custom role"}</DialogTitle>
          <DialogDescription>
            Roles grant organization administration only. Cache access always comes from project
            grants. You can only grant permissions you hold.
          </DialogDescription>
        </DialogHeader>
        {role ? null : (
          <Field>
            <FieldLabel htmlFor="role-name">Role name</FieldLabel>
            <Input
              id="role-name"
              className="font-mono"
              pattern="[a-zA-Z0-9_-]+"
              maxLength={64}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>
              Letters, numbers, dashes and underscores, e.g. release-manager.
            </FieldDescription>
          </Field>
        )}
        <PermissionChecklist value={permissions} onChange={setPermissions} allowed={mine.can} />
        {action.error === undefined ? null : <ErrorState error={action.error} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={action.busy || (!role && !/^[a-zA-Z0-9_-]+$/.test(name.trim()))}
            onClick={() => void save()}
          >
            {action.busy ? "Saving…" : "Save role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RolesPage() {
  const org = useOrg();
  const permissions = useOrgPermissions();
  const roles = useResource(`roles:${org.id}`, (signal) => listRoles(org.id, signal));
  const [editing, setEditing] = useState<CustomRole | "new">();
  const [deleting, setDeleting] = useState<CustomRole>();

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Roles"
        description="Built-in roles plus custom roles for finer administration."
        actions={
          permissions.can("ac", "create") ? (
            <Button onClick={() => setEditing("new")}>
              <Plus data-icon="inline-start" />
              New role
            </Button>
          ) : null
        }
      />
      {editing ? (
        <RoleEditor
          key={editing === "new" ? "new" : editing.id}
          open
          onOpenChange={(open) => !open && setEditing(undefined)}
          role={editing === "new" ? undefined : editing}
          onSaved={roles.reload}
        />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Custom roles</CardTitle>
          <CardDescription>Assign them to members on the Members page.</CardDescription>
        </CardHeader>
        <CardContent>
          {roles.status === "error" ? (
            <ErrorState error={roles.error} onRetry={roles.reload} />
          ) : !roles.data ? (
            <LoadingRows rows={2} />
          ) : roles.data.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck />}
              title="No custom roles"
              description="Built-in roles cover most organizations."
            />
          ) : (
            <ul className="flex flex-col divide-y">
              {roles.data.map((role) => (
                <li key={role.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex items-center gap-3">
                    <code className="font-mono text-sm">{role.role}</code>
                    <Badge variant="outline">{count(rolePermissions(role))} permissions</Badge>
                  </span>
                  <span className="flex gap-1">
                    {permissions.can("ac", "update") ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${role.role}`}
                        onClick={() => setEditing(role)}
                      >
                        <Pencil />
                      </Button>
                    ) : null}
                    {permissions.can("ac", "delete") ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${role.role}`}
                        onClick={() => setDeleting(role)}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={`Delete ${deleting?.role ?? "role"}?`}
        description="Members who hold only this role keep their membership but lose its permissions."
        confirmLabel="Delete role"
        destructive
        onConfirm={async () => {
          if (deleting) await deleteRole(org.id, deleting.role);
          roles.reload();
        }}
      />
      <section aria-labelledby="builtin-title" className="flex flex-col gap-4">
        <h2 id="builtin-title" className="text-lg font-semibold tracking-tight">
          Built-in roles
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {Object.entries(builtInOrganizationRoles).map(([name, grants]) => (
            <Card key={name}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <code className="font-mono">{name}</code>
                  <Badge variant="secondary">{count(grants)} permissions</Badge>
                </CardTitle>
              </CardHeader>
              {count(grants) > 0 ? (
                <CardContent>
                  <PermissionChecklist value={grants} allowed={() => true} />
                </CardContent>
              ) : (
                <CardContent className="text-xs text-muted-foreground">
                  No administration permissions. Project access comes from grants.
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}
