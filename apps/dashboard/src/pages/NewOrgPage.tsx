import { useState } from "react";
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
import { errorMessage } from "../lib/api.ts";
import { authClient } from "../lib/auth-client.ts";
import { orgPath } from "../lib/org.tsx";
import { navigate } from "../lib/router.tsx";

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** Creates an organization; its immutable slug becomes `TURBO_TEAM`. */
export function CreateOrgForm({
  onCreated,
}: {
  readonly onCreated: (org: { id: string; slug: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const effectiveSlug = slugEdited ? slug : slugify(name);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await authClient.organization.create({ name: name.trim(), slug: effectiveSlug });

    if (result.error || !result.data) {
      setError(new Error(result.error?.message ?? "The organization could not be created."));
      setBusy(false);

      return;
    }

    onCreated(result.data);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
          <Input
            id="org-name"
            required
            maxLength={64}
            value={name}
            autoComplete="organization"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="org-slug">Team slug</FieldLabel>
          <Input
            id="org-slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={48}
            value={effectiveSlug}
            className="font-mono"
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
          />
          <FieldDescription>
            Becomes <code className="font-mono">TURBO_TEAM={effectiveSlug || "your-team"}</code>. It
            can't be changed later.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <p role="status" className="text-sm text-destructive">
        {error === undefined ? "" : errorMessage(error)}
      </p>
      <Button type="submit" disabled={busy || !name.trim() || !effectiveSlug}>
        {busy ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}

export function NewOrgPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Create an organization</CardTitle>
          <CardDescription>
            Organizations own projects, members, credentials and audit history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrgForm onCreated={(org) => navigate(orgPath(org))} />
        </CardContent>
        <CardFooter className="text-xs text-muted-foreground">
          Your instance policy may restrict who can create organizations.
        </CardFooter>
      </Card>
    </div>
  );
}
