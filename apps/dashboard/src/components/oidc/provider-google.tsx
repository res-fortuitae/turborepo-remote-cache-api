"use client";

import * as React from "react";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";

import { cn } from "@repo/ui/lib/utils";
import { Button } from "@repo/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import {
  ClaimChip,
  ClaimsList,
  claimRowsFromPolicy,
  claimsListValid,
  mergeClaimRows,
  type ClaimRow,
} from "./claims.tsx";
import type { OidcPolicy } from "../../lib/oidc/policy.ts";

function GoogleIcon({ ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}

const emailSchema = z
  .string()
  .min(1, "Enter the service account email.")
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Enter a valid email address.");
const uniqueIdSchema = z.union([z.literal(""), z.string().regex(/^\d+$/, "The numeric ID only.")]);
const audienceSchema = z.string().min(1, "Enter the audience.");

type Fields = {
  email: z.infer<typeof emailSchema>;
  uniqueId: z.infer<typeof uniqueIdSchema>;
  audience: z.infer<typeof audienceSchema>;
  extraClaims: ClaimRow[];
};

const DEFAULTS: Fields = {
  email: "",
  uniqueId: "",
  audience: "",
  extraClaims: [],
};

const FIRST_CLASS_CLAIMS = ["aud", "email", "sub"];

const ISSUER = "https://accounts.google.com";

// Identity is the service account email; the numeric unique ID (sub)
// survives account deletion and recreation, so pin it when known.
function compile(fields: Fields) {
  const claims: Record<string, string[]> = {};
  if (fields.audience) {
    claims.aud = [fields.audience];
  }
  if (fields.email) {
    claims.email = [fields.email];
  }
  if (fields.uniqueId) {
    claims.sub = [fields.uniqueId];
  }
  mergeClaimRows(claims, fields.extraClaims, FIRST_CLASS_CLAIMS);
  return { issuer: ISSUER, claims };
}

function parse(policy: OidcPolicy) {
  if (policy.issuer !== ISSUER) {
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
    email: policy.claims.email?.[0] ?? "",
    uniqueId: policy.claims.sub?.[0] ?? "",
    audience: policy.claims.aud?.[0] ?? "",
    extraClaims,
  };
}

/** True when this form can represent the policy — for routing an edit. */
function matchesGooglePolicy(policy: OidcPolicy) {
  return parse(policy) !== null;
}

function GooglePolicyForm({
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
      data-slot="google-policy-form"
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <Field>
        <FieldLabel htmlFor="gc-issuer" className="w-full">
          Issuer <ClaimChip>iss</ClaimChip>
        </FieldLabel>
        <Input id="gc-issuer" value={ISSUER} readOnly disabled />
        <FieldDescription>Fixed for Google service accounts.</FieldDescription>
      </Field>
      <form.Field name="email" validators={{ onChange: emailSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="gc-email" className="w-full">
                Service account email <ClaimChip>email</ClaimChip>
              </FieldLabel>
              <Input
                id="gc-email"
                value={field.state.value}
                placeholder="deploy-bot@acme-prod.iam.gserviceaccount.com"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="uniqueId" validators={{ onChange: uniqueIdSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="gc-uniqueId" className="w-full">
                Unique ID <ClaimChip>sub</ClaimChip>
              </FieldLabel>
              <Input
                id="gc-uniqueId"
                value={field.state.value}
                placeholder="117234567890123456789"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Optional: IAM → Service Accounts → Unique ID. Survives account recreation.
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
              <FieldLabel htmlFor="gc-audience" className="w-full">
                Audience <ClaimChip>aud</ClaimChip>
              </FieldLabel>
              <Input
                id="gc-audience"
                value={field.state.value}
                placeholder="https://your-app.example.com"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>The audience the caller requests its token for.</FieldDescription>
            </Field>
          );
        }}
      </form.Field>
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

export { GoogleIcon, GooglePolicyForm, matchesGooglePolicy };
