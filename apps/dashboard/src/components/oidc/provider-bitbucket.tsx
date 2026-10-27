import * as React from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { z } from "zod";

import { cn } from "@repo/ui/lib/utils";
import { Button } from "@repo/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Alert, AlertTitle } from "@repo/ui/components/alert";
import {
  ClaimChip,
  ClaimsList,
  claimRowsFromPolicy,
  claimsListValid,
  mergeClaimRows,
  type ClaimRow,
} from "./claims.tsx";
import type { OidcPolicy } from "../../lib/oidc/policy.ts";

function BitbucketIcon({ ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z" />
    </svg>
  );
}

const issuerSchema = z
  .string()
  .min(1, "Paste the identity provider URL.")
  .regex(
    /^https:\/\/api\.bitbucket\.org\/2\.0\/workspaces\/.+\/pipelines-config\/identity\/oidc$/,
    "Copy the exact URL from repository settings.",
  );
const audienceSchema = z.string().min(1, "Paste the audience.");
const repositoryUuidSchema = z.string();

type Fields = {
  issuer: z.infer<typeof issuerSchema>;
  audience: z.infer<typeof audienceSchema>;
  repositoryUuid: z.infer<typeof repositoryUuidSchema>;
  extraClaims: ClaimRow[];
};

const DEFAULTS: Fields = {
  issuer: "",
  audience: "",
  repositoryUuid: "",
  extraClaims: [],
};

const FIRST_CLASS_CLAIMS = ["aud", "repositoryUuid"];

const WORKSPACE_AUD_PREFIX = "ari:cloud:bitbucket::workspace/";

// Bitbucket UUID claims are brace-wrapped; accept bare pastes too.
function braced(uuid: string) {
  if (!uuid) {
    return uuid;
  }
  return uuid.startsWith("{") ? uuid : `{${uuid.replace(/}$/, "")}}`;
}

function compile(fields: Fields) {
  const claims: Record<string, string[]> = {};
  if (fields.audience) {
    claims.aud = [fields.audience];
  }
  if (fields.repositoryUuid) {
    claims.repositoryUuid = [braced(fields.repositoryUuid)];
  }
  mergeClaimRows(claims, fields.extraClaims, FIRST_CLASS_CLAIMS);
  return { issuer: fields.issuer, claims };
}

function parse(policy: OidcPolicy) {
  if (
    !policy.issuer.startsWith("https://api.bitbucket.org/2.0/workspaces/") ||
    !policy.issuer.endsWith("/pipelines-config/identity/oidc")
  ) {
    return null;
  }
  if (FIRST_CLASS_CLAIMS.some((name) => (policy.claims[name]?.length ?? 0) > 1)) {
    return null;
  }
  const extraClaims = claimRowsFromPolicy(policy.claims, FIRST_CLASS_CLAIMS);
  if (extraClaims === null) {
    return null;
  }

  return {
    issuer: policy.issuer,
    audience: policy.claims.aud?.[0] ?? "",
    repositoryUuid: policy.claims.repositoryUuid?.[0] ?? "",
    extraClaims,
  };
}

/** True when this form can represent the policy — for routing an edit. */
function matchesBitbucketPolicy(policy: OidcPolicy) {
  return parse(policy) !== null;
}

function BitbucketPolicyForm({
  defaultValue,
  onChange,
  onSubmit,
  className,
}: {
  defaultValue?: OidcPolicy;
  onChange?: (policy: OidcPolicy) => void;
  onSubmit: (policy: OidcPolicy) => void;
  className?: string;
}) {
  const form = useForm({
    defaultValues: (defaultValue ? (parse(defaultValue) ?? DEFAULTS) : DEFAULTS) as Fields,
    onSubmit: ({ value: fields }) => {
      if (!claimsListValid(fields.extraClaims)) {
        return;
      }
      const policy = compile(fields);
      onSubmit(defaultValue?.label ? { ...policy, label: defaultValue.label } : policy);
    },
  });
  const values = {
    audience: useStore(form.store, (state) => state.values.audience),
    repositoryUuid: useStore(form.store, (state) => state.values.repositoryUuid),
  };

  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    let previousValues = form.store.state.values;
    const subscription = form.store.subscribe(() => {
      const { values } = form.store.state;
      if (values === previousValues) {
        return;
      }
      previousValues = values;
      const policy = compile(values);
      onChangeRef.current?.(
        defaultValue?.label ? { ...policy, label: defaultValue.label } : policy,
      );
    });
    return () => subscription.unsubscribe();
  }, [form, defaultValue?.label]);

  return (
    <form
      data-slot="bitbucket-policy-form"
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="issuer" validators={{ onChange: issuerSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="bb-issuer" className="w-full">
                Identity provider URL <ClaimChip>iss</ClaimChip>
              </FieldLabel>
              <Input
                id="bb-issuer"
                value={field.state.value}
                placeholder="https://api.bitbucket.org/2.0/workspaces/acme/pipelines-config/identity/oidc"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Repository → Settings → Pipelines → OpenID Connect. Copy it exactly.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="audience" validators={{ onChange: audienceSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="bb-audience" className="w-full">
                Audience <ClaimChip>aud</ClaimChip>
              </FieldLabel>
              <Input
                id="bb-audience"
                value={field.state.value}
                placeholder="ari:cloud:bitbucket::workspace/…"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Same settings page. Pipelines can also declare custom audiences in the step&apos;s
                oidc config.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="repositoryUuid" validators={{ onChange: repositoryUuidSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="bb-repositoryUuid" className="w-full">
                Repository UUID <ClaimChip>repositoryUuid</ClaimChip>
              </FieldLabel>
              <Input
                id="bb-repositoryUuid"
                value={field.state.value}
                placeholder="{9a8b7c6d-…}"
                className="font-mono"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                From the example payload on the same page. Optional to narrow trust to one
                repository.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      {values.audience &&
      !values.audience.startsWith(WORKSPACE_AUD_PREFIX) &&
      !values.repositoryUuid ? (
        <Alert>
          <AlertTitle>
            A custom audience doesn&apos;t name the workspace — add the repository UUID so this rule
            still pins an identity.
          </AlertTitle>
        </Alert>
      ) : null}
      <form.Field name="extraClaims">
        {(field) => (
          <ClaimsList
            value={field.state.value}
            onChange={field.handleChange}
            reserved={FIRST_CLASS_CLAIMS}
          />
        )}
      </form.Field>
      <Button type="submit" className="self-start">
        Save
      </Button>
    </form>
  );
}

export { BitbucketIcon, BitbucketPolicyForm, matchesBitbucketPolicy };
