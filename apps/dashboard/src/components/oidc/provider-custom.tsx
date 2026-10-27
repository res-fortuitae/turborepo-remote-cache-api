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

function CustomOidcIcon({ ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M14.54.889l-3.63 1.773v18.17c-4.15-.52-7.27-2.78-7.27-5.5 0-2.58 2.8-4.75 6.63-5.41v-2.31C4.42 8.322 0 11.502 0 15.332c0 3.96 4.74 7.24 10.91 7.78l3.63-1.71V.888m.64 6.724v2.31c1.43.25 2.71.7 3.76 1.31l-1.97 1.11 7.03 1.53-.5-5.21-1.87 1.06c-1.74-1.06-3.96-1.81-6.45-2.11z" />
    </svg>
  );
}

const issuerSchema = z
  .string()
  .min(1, "Enter the issuer URL.")
  .regex(/^https:\/\/[^?#\s]+$/, "Enter an https:// URL without query or fragment.");
const audienceSchema = z.string().min(1, "Enter the audience.");
const subjectSchema = z.string();

type Fields = {
  issuer: z.infer<typeof issuerSchema>;
  audience: z.infer<typeof audienceSchema>;
  subject: z.infer<typeof subjectSchema>;
  extraClaims: ClaimRow[];
};

const DEFAULTS: Fields = {
  issuer: "",
  audience: "",
  subject: "",
  extraClaims: [],
};

const FIRST_CLASS_CLAIMS = ["aud", "sub"];

function parsePastedIssuer(text: string) {
  const match = text.trim().match(/^(https:\/\/[^?#\s]+?)\/\.well-known\/openid-configuration\/?$/);
  return match?.[1] ? { issuer: match[1] } : null;
}

// The escape hatch: any OIDC issuer. Matches broadly, so list it LAST in the
// providers array — edit-routing tries providers in order.
function compile(fields: Fields) {
  const claims: Record<string, string[]> = {};
  if (fields.audience) {
    claims.aud = [fields.audience];
  }
  if (fields.subject) {
    claims.sub = [fields.subject];
  }
  mergeClaimRows(claims, fields.extraClaims, FIRST_CLASS_CLAIMS);
  return { issuer: fields.issuer, claims };
}

function parse(policy: OidcPolicy) {
  if (!policy.issuer.startsWith("https://")) {
    return null;
  }
  if ((policy.claims.aud?.length ?? 0) > 1) {
    return null;
  }
  if ((policy.claims.sub?.length ?? 0) > 1) {
    return null;
  }

  const extraClaims = claimRowsFromPolicy(policy.claims, FIRST_CLASS_CLAIMS);
  if (extraClaims === null) {
    return null;
  }

  return {
    issuer: policy.issuer,
    audience: policy.claims.aud?.[0] ?? "",
    subject: policy.claims.sub?.[0] ?? "",
    extraClaims,
  };
}

/** True when this form can represent the policy — for routing an edit. */
function matchesCustomPolicy(policy: OidcPolicy) {
  return parse(policy) !== null;
}

function CustomPolicyForm({
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
    issuer: useStore(form.store, (state) => state.values.issuer),
    audience: useStore(form.store, (state) => state.values.audience),
    subject: useStore(form.store, (state) => state.values.subject),
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
      data-slot="custom-policy-form"
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
              <FieldLabel htmlFor="cu-issuer" className="w-full">
                Issuer <ClaimChip>iss</ClaimChip>
              </FieldLabel>
              <Input
                id="cu-issuer"
                value={field.state.value}
                placeholder="https://issuer.example.com"
                className="font-mono"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
                onPaste={(event) => {
                  const patch = parsePastedIssuer(event.clipboardData.getData("text"));
                  if (!patch) {
                    return;
                  }
                  event.preventDefault();
                  form.reset({ ...form.store.state.values, ...patch }, { keepDefaultValues: true });
                }}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                The issuer&apos;s OIDC discovery root — pasting a discovery URL works too.
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
              <FieldLabel htmlFor="cu-audience" className="w-full">
                Audience <ClaimChip>aud</ClaimChip>
              </FieldLabel>
              <Input
                id="cu-audience"
                value={field.state.value}
                placeholder="https://your-app.example.com"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                The audience the caller requests its token for. Pick a value unique to your app.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="subject" validators={{ onChange: subjectSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="cu-subject" className="w-full">
                Subject <ClaimChip>sub</ClaimChip>
              </FieldLabel>
              <Input
                id="cu-subject"
                value={field.state.value}
                placeholder="system:serviceaccount:default:deploy-bot"
                className="font-mono"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Optional: the issuer&apos;s primary identifier for the caller.
              </FieldDescription>
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
      {values.issuer && values.audience && !values.subject ? (
        <Alert>
          <AlertTitle>
            Without a subject, every workload this issuer signs tokens for is trusted.
          </AlertTitle>
        </Alert>
      ) : null}
      <Button type="submit" className="self-start">
        Save
      </Button>
    </form>
  );
}

export { CustomOidcIcon, CustomPolicyForm, matchesCustomPolicy };
