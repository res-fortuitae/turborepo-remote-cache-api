"use client";

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

function VercelIcon({ ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="m12 1.608 12 20.784H0Z" />
    </svg>
  );
}

const teamSlugSchema = z
  .string()
  .min(1, "Enter the team slug.")
  .regex(/^[\w-]+$/, "Letters, digits, and hyphens only.");
const ownerIdSchema = z
  .string()
  .min(1, "Enter the team ID.")
  .regex(/^team_/, 'Team IDs start with "team_".');
const projectIdSchema = z.union([
  z.literal(""),
  z.string().regex(/^prj_/, 'Project IDs start with "prj_".'),
]);
const environmentSchema = z.string();
const audienceSchema = z.string().min(1, "Enter the audience.");

type Fields = {
  teamSlug: z.infer<typeof teamSlugSchema>;
  ownerId: z.infer<typeof ownerIdSchema>;
  projectId: z.infer<typeof projectIdSchema>;
  environment: z.infer<typeof environmentSchema>;
  audience: z.infer<typeof audienceSchema>;
  extraClaims: ClaimRow[];
};

const DEFAULTS: Fields = {
  teamSlug: "",
  ownerId: "",
  projectId: "",
  environment: "",
  audience: "",
  extraClaims: [],
};

const FIRST_CLASS_CLAIMS = ["aud", "owner_id", "project_id", "environment"];

const GLOBAL_ISSUER = "https://oidc.vercel.com";

function defaultAudience(teamSlug: string) {
  return teamSlug ? `https://vercel.com/${teamSlug}` : "";
}

function compile(fields: Fields) {
  const claims: Record<string, string[]> = {};
  if (fields.audience) {
    claims.aud = [fields.audience];
  }
  if (fields.ownerId) {
    claims.owner_id = [fields.ownerId];
  }
  if (fields.projectId) {
    claims.project_id = [fields.projectId];
  }
  if (fields.environment) {
    claims.environment = [fields.environment];
  }
  mergeClaimRows(claims, fields.extraClaims, FIRST_CLASS_CLAIMS);
  return {
    issuer: fields.teamSlug ? `${GLOBAL_ISSUER}/${fields.teamSlug}` : "",
    claims,
  };
}

function parse(policy: OidcPolicy) {
  if (!policy.issuer.startsWith(`${GLOBAL_ISSUER}/`)) {
    return null;
  }
  const teamSlug = policy.issuer.slice(`${GLOBAL_ISSUER}/`.length);
  if (!/^[\w-]+$/.test(teamSlug)) {
    return null;
  }

  if (FIRST_CLASS_CLAIMS.some((name) => (policy.claims[name]?.length ?? 0) > 1)) {
    return null;
  }
  const extraClaims = claimRowsFromPolicy(policy.claims, FIRST_CLASS_CLAIMS);
  if (extraClaims === null) {
    return null;
  }

  const [aud = ""] = policy.claims.aud ?? [];

  return {
    teamSlug,
    ownerId: policy.claims.owner_id?.[0] ?? "",
    projectId: policy.claims.project_id?.[0] ?? "",
    environment: policy.claims.environment?.[0] ?? "",
    audience: aud,
    extraClaims,
  };
}

/** True when this form can represent the policy — for routing an edit. */
function matchesVercelPolicy(policy: OidcPolicy) {
  return parse(policy) !== null;
}

function VercelPolicyForm({
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
    teamSlug: useStore(form.store, (state) => state.values.teamSlug),
    environment: useStore(form.store, (state) => state.values.environment),
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
      data-slot="vercel-policy-form"
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="teamSlug" validators={{ onChange: teamSlugSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="vc-teamSlug" className="w-full">
                Team slug <ClaimChip>iss</ClaimChip>
              </FieldLabel>
              <Input
                id="vc-teamSlug"
                value={field.state.value}
                placeholder="acme"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>The team URL segment: vercel.com/acme.</FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="ownerId" validators={{ onChange: ownerIdSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="vc-ownerId" className="w-full">
                Team ID <ClaimChip>owner_id</ClaimChip>
              </FieldLabel>
              <Input
                id="vc-ownerId"
                value={field.state.value}
                placeholder="team_xxxxxxxx"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>Team settings → General → Team ID.</FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="projectId" validators={{ onChange: projectIdSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="vc-projectId" className="w-full">
                Project ID <ClaimChip>project_id</ClaimChip>
              </FieldLabel>
              <Input
                id="vc-projectId"
                value={field.state.value}
                placeholder="prj_xxxxxxxx"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Project settings → General → Project ID. Leave empty to trust the whole team.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="environment" validators={{ onChange: environmentSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="vc-environment" className="w-full">
                Environment <ClaimChip>environment</ClaimChip>
              </FieldLabel>
              <Input
                id="vc-environment"
                value={field.state.value}
                placeholder="production"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>Optional: production, preview, or development.</FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="audience" validators={{ onChange: audienceSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="vc-audience" className="w-full">
                Audience <ClaimChip>aud</ClaimChip>
              </FieldLabel>
              <Input
                id="vc-audience"
                value={field.state.value}
                placeholder={defaultAudience(values.teamSlug) || "https://vercel.com/acme"}
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                The team URL is the default tokens carry; deployments can request a custom audience
                via Vercel&apos;s token exchange.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      {values.teamSlug ? (
        <FieldDescription>
          Issuer derived automatically:{" "}
          <span className="font-mono">
            {GLOBAL_ISSUER}/{values.teamSlug}
          </span>
        </FieldDescription>
      ) : null}
      {values.teamSlug && !values.environment ? (
        <Alert>
          <AlertTitle>
            Without an environment, preview deployments get the same access as production.
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

export { VercelIcon, VercelPolicyForm, matchesVercelPolicy };
