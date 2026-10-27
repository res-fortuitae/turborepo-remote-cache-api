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

function AzureIcon({ ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M22.379 23.343a1.62 1.62 0 0 0 1.536-2.14v.002L17.35 1.76A1.62 1.62 0 0 0 15.816.657H8.184A1.62 1.62 0 0 0 6.65 1.76L.086 21.204a1.62 1.62 0 0 0 1.536 2.139h4.741a1.62 1.62 0 0 0 1.535-1.103l.977-2.892 4.947 3.675c.28.208.618.32.966.32m-3.084-12.531 3.624 10.739a.54.54 0 0 1-.51.713v-.001h-.03a.54.54 0 0 1-.322-.106l-9.287-6.9h4.853m6.313 7.006c.116-.326.13-.694.007-1.058L9.79 1.76a1.722 1.722 0 0 0-.007-.02h6.034a.54.54 0 0 1 .512.366l6.562 19.445a.54.54 0 0 1-.338.684" />
    </svg>
  );
}

const tenantIdSchema = z
  .string()
  .min(1, "Enter the tenant ID.")
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "Enter the tenant GUID.",
  );
const objectIdSchema = z
  .string()
  .min(1, "Enter the object ID.")
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "Enter the object GUID.",
  );
const clientIdSchema = z.union([
  z.literal(""),
  z
    .string()
    .regex(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      "Enter the client GUID.",
    ),
]);
const audienceSchema = z.string().min(1, "Enter the audience.");

type Fields = {
  tenantId: z.infer<typeof tenantIdSchema>;
  objectId: z.infer<typeof objectIdSchema>;
  clientId: z.infer<typeof clientIdSchema>;
  audience: z.infer<typeof audienceSchema>;
  extraClaims: ClaimRow[];
};

const DEFAULTS: Fields = {
  tenantId: "",
  objectId: "",
  clientId: "",
  audience: "",
  extraClaims: [],
};

const FIRST_CLASS_CLAIMS = ["aud", "oid", "azp"];

const ISSUER_PATTERN =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/;

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Entra tokens carry lowercase GUIDs; normalize pastes.
function compile(fields: Fields) {
  const claims: Record<string, string[]> = {};
  if (fields.audience) {
    claims.aud = [fields.audience];
  }
  if (fields.objectId) {
    claims.oid = [fields.objectId.toLowerCase()];
  }
  if (fields.clientId) {
    claims.azp = [fields.clientId.toLowerCase()];
  }
  mergeClaimRows(claims, fields.extraClaims, FIRST_CLASS_CLAIMS);
  return {
    issuer: `https://login.microsoftonline.com/${fields.tenantId.toLowerCase()}/v2.0`,
    claims,
  };
}

function parse(policy: OidcPolicy) {
  const tenantId = ISSUER_PATTERN.exec(policy.issuer)?.[1];
  if (!tenantId) {
    return null;
  }
  if (FIRST_CLASS_CLAIMS.some((name) => (policy.claims[name]?.length ?? 0) > 1)) {
    return null;
  }
  const objectId = policy.claims.oid?.[0] ?? "";
  const clientId = policy.claims.azp?.[0] ?? "";
  if ((objectId && !GUID_PATTERN.test(objectId)) || (clientId && !GUID_PATTERN.test(clientId))) {
    return null;
  }
  const extraClaims = claimRowsFromPolicy(policy.claims, FIRST_CLASS_CLAIMS);
  if (extraClaims === null) {
    return null;
  }

  return {
    tenantId,
    objectId,
    clientId,
    audience: policy.claims.aud?.[0] ?? "",
    extraClaims,
  };
}

/** True when this form can represent the policy — for routing an edit. */
function matchesAzurePolicy(policy: OidcPolicy) {
  return parse(policy) !== null;
}

function AzurePolicyForm({
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
      data-slot="azure-policy-form"
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="tenantId" validators={{ onChange: tenantIdSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="az-tenantId" className="w-full">
                Tenant ID <ClaimChip>iss</ClaimChip>
              </FieldLabel>
              <Input
                id="az-tenantId"
                value={field.state.value}
                placeholder="aaaabbbb-0000-cccc-1111-dddd2222eeee"
                className="font-mono"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Entra admin center → Overview → Tenant ID. Sets the issuer
                https://login.microsoftonline.com/&lt;tenant&gt;/v2.0.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="objectId" validators={{ onChange: objectIdSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="az-objectId" className="w-full">
                Object ID <ClaimChip>oid</ClaimChip>
              </FieldLabel>
              <Input
                id="az-objectId"
                value={field.state.value}
                placeholder="aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb"
                className="font-mono"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                The workload&apos;s Object (principal) ID. Survives renames.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="clientId" validators={{ onChange: clientIdSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="az-clientId" className="w-full">
                Application (client) ID <ClaimChip>azp</ClaimChip>
              </FieldLabel>
              <Input
                id="az-clientId"
                value={field.state.value}
                placeholder="00001111-aaaa-2222-bbbb-3333cccc4444"
                className="font-mono"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Optional: also pin the app registration the token was issued to.
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
              <FieldLabel htmlFor="az-audience" className="w-full">
                Audience <ClaimChip>aud</ClaimChip>
              </FieldLabel>
              <Input
                id="az-audience"
                value={field.state.value}
                placeholder="api://your-app"
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

export { AzureIcon, AzurePolicyForm, matchesAzurePolicy };
