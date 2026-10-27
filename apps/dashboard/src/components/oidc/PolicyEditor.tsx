import { lazy, Suspense, useState } from "react";
import type { TrustPolicy } from "@repo/shared";
import { Button } from "@repo/ui/components/button";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Textarea } from "@repo/ui/components/textarea";
import { ErrorState, LoadingRows } from "../common.tsx";
import { NativeSelect, useAction } from "../forms.tsx";
import { savePolicy } from "../../lib/credentials.ts";
import type { OidcPolicy } from "../../lib/oidc/policy.ts";
import { ProviderPicker } from "./picker.tsx";

// Provider forms are sizeable; load the selected provider on demand.
const forms = {
  github: lazy(() =>
    import("./provider-github.tsx").then((m) => ({ default: m.GithubPolicyForm })),
  ),
  vercel: lazy(() =>
    import("./provider-vercel.tsx").then((m) => ({ default: m.VercelPolicyForm })),
  ),
  gitlab: lazy(() =>
    import("./provider-gitlab.tsx").then((m) => ({ default: m.GitlabPolicyForm })),
  ),
  google: lazy(() =>
    import("./provider-google.tsx").then((m) => ({ default: m.GooglePolicyForm })),
  ),
  bitbucket: lazy(() =>
    import("./provider-bitbucket.tsx").then((m) => ({ default: m.BitbucketPolicyForm })),
  ),
  "aws-eks": lazy(() => import("./provider-aws.tsx").then((m) => ({ default: m.AwsPolicyForm }))),
  azure: lazy(() => import("./provider-azure.tsx").then((m) => ({ default: m.AzurePolicyForm }))),
  custom: lazy(() =>
    import("./provider-custom.tsx").then((m) => ({ default: m.CustomPolicyForm })),
  ),
};
type Provider = keyof typeof forms;
const providers = Object.keys(forms).map((value) => ({
  value,
  label:
    (
      { github: "GitHub Actions", "aws-eks": "AWS EKS", gitlab: "GitLab CI" } as Record<
        string,
        string
      >
    )[value] ?? value[0]!.toUpperCase() + value.slice(1),
}));
const identityFields: Partial<Record<Provider, readonly string[]>> = {
  github: ["repository_id", "repository_owner_id"],
  vercel: ["owner_id", "project_id"],
  gitlab: ["project_id", "namespace_id"],
  google: ["sub"],
  bitbucket: ["workspaceUuid", "repositoryUuid"],
  "aws-eks": ["sub"],
  azure: ["tid", "oid"],
  custom: ["sub"],
};

export function PolicyEditor({
  projectId,
  existing,
  onSaved,
  onCancel,
}: {
  readonly projectId: string;
  readonly existing?: typeof TrustPolicy.Type;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const [provider, setProvider] = useState<Provider>(
    existing && existing.provider in forms ? (existing.provider as Provider) : "github",
  );
  const [label, setLabel] = useState(existing?.label ?? "");
  const [audience, setAudience] = useState(
    existing?.claims.aud?.join(", ") ?? window.location.origin,
  );
  const [scope, setScope] = useState<"read" | "read write">(existing?.scope ?? "read");
  const [ttl, setTtl] = useState(String(existing?.ttlSeconds ?? 600));
  const [bound, setBound] = useState(existing?.requireBoundTokens ?? true);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [ids, setIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (identityFields[provider] ?? []).map((name) => [
        name,
        existing?.claims[name]?.join(", ") ?? "",
      ]),
    ),
  );
  const [workflow, setWorkflow] = useState(existing?.claims.job_workflow_ref?.join(", ") ?? "");
  const [environment, setEnvironment] = useState(existing?.claims.environment?.join(", ") ?? "");
  const [refs, setRefs] = useState(existing?.refPatterns?.join("\n") ?? "");
  const [draft, setDraft] = useState<OidcPolicy>();
  // Editing the exact contract preserves policies that provider-specific forms cannot represent.
  const [raw, setRaw] = useState(
    existing ? JSON.stringify({ issuer: existing.issuer, claims: existing.claims }, null, 2) : "",
  );
  const action = useAction();
  const Form = forms[provider];
  const values = (text: string) =>
    text
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  async function save(policy: OidcPolicy) {
    await action.run(async () => {
      const claims: Record<string, string[]> = { ...policy.claims, aud: values(audience) };
      for (const name of identityFields[provider] ?? []) {
        if (Object.hasOwn(ids, name)) {
          if (ids[name]?.trim()) claims[name] = values(ids[name]!);
          else delete claims[name];
        }
      }
      if (workflow.trim()) claims.job_workflow_ref = values(workflow);
      else if (existing) delete claims.job_workflow_ref;
      if (environment.trim()) claims.environment = values(environment);
      else if (existing) delete claims.environment;
      await savePolicy(
        projectId,
        {
          provider: existing?.provider ?? provider,
          enabled,
          issuer: policy.issuer,
          claims,
          label,
          scope,
          ttlSeconds: Number(ttl),
          requireBoundTokens: bound,
          refPatterns: refs.trim()
            ? refs
                .split("\n")
                .map((ref) => ref.trim())
                .filter(Boolean)
            : undefined,
          allowUntrustedWrites: existing?.allowUntrustedWrites ?? false,
        },
        existing?.id,
      );
      onSaved();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {existing ? (
        <p className="text-sm">Provider: {existing.provider}</p>
      ) : (
        <ProviderPicker
          providers={providers}
          value={provider}
          onValueChange={(value) => {
            setProvider(value as Provider);
            setIds({});
            setDraft(undefined);
          }}
        />
      )}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="policy-label">Label</FieldLabel>
          <Input id="policy-label" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="policy-audience">API audience</FieldLabel>
          <Input
            id="policy-audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          />
          <FieldDescription>
            Must match a configured API audience. Comma-separated for multiple audiences. This
            replaces the provider form's default audience.
          </FieldDescription>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="policy-scope">Cache scope</FieldLabel>
            <NativeSelect
              id="policy-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as typeof scope)}
            >
              <option value="read">Read only</option>
              <option value="read write">Read and write</option>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="policy-ttl">Token lifetime (seconds)</FieldLabel>
            <Input
              id="policy-ttl"
              type="number"
              min={1}
              max={3600}
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
            />
          </Field>
        </div>
        {(identityFields[provider] ?? []).map((name) => (
          <Field key={name}>
            <FieldLabel htmlFor={`identity-${name}`}>Immutable identity: {name}</FieldLabel>
            <Input
              id={`identity-${name}`}
              value={ids[name] ?? ""}
              onChange={(e) => setIds({ ...ids, [name]: e.target.value })}
            />
            <FieldDescription>
              Exact claim values, never display names. May also be supplied in the provider form
              below.
            </FieldDescription>
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor="policy-workflow">Required workflow reference</FieldLabel>
          <Input
            id="policy-workflow"
            placeholder="acme/repo/.github/workflows/build.yml@refs/heads/main"
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="policy-environment">Required environment</FieldLabel>
          <Input
            id="policy-environment"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="policy-refs">Allowed ref patterns</FieldLabel>
          <Textarea
            id="policy-refs"
            placeholder="One pattern per line"
            value={refs}
            onChange={(e) => setRefs(e.target.value)}
          />
          <FieldDescription>
            Patterns apply only to refs. Claim rules use exact matching. Write policies also need
            trusted event restrictions in the provider's additional claims.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="policy-bound"
            checked={bound}
            onCheckedChange={(v) => setBound(v === true)}
          />
          <FieldLabel htmlFor="policy-bound">Require DPoP-bound tokens</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="policy-enabled"
            checked={enabled}
            onCheckedChange={(v) => setEnabled(v === true)}
          />
          <FieldLabel htmlFor="policy-enabled">Enabled</FieldLabel>
        </Field>
      </FieldGroup>
      {existing ? (
        <Field>
          <FieldLabel htmlFor="policy-contract">Issuer and exact claim rules</FieldLabel>
          <Textarea
            id="policy-contract"
            rows={12}
            className="font-mono"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <FieldDescription>
            Existing policies retain every claim. Immutable identity and audience fields above
            override these rules when filled.
          </FieldDescription>
        </Field>
      ) : (
        <fieldset disabled={action.busy}>
          <Suspense fallback={<LoadingRows />}>
            <Form key={provider} onChange={setDraft} onSubmit={(policy) => void save(policy)} />
          </Suspense>
        </fieldset>
      )}
      {draft ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Provider claim preview
          </summary>
          <pre className="overflow-auto text-xs">{JSON.stringify(draft, null, 2)}</pre>
        </details>
      ) : null}
      {action.error === undefined ? null : <ErrorState error={action.error} />}
      <div className="flex gap-2">
        {existing ? (
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const value: unknown = JSON.parse(raw);
                const parsed = value as OidcPolicy;
                await save(parsed);
              })
            }
          >
            Save policy
          </Button>
        ) : null}
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
