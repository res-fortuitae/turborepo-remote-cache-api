import * as React from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { z } from "zod";

import { cn } from "@repo/ui/lib/utils";
import { Button } from "@repo/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import {
  ClaimChip,
  ClaimsList,
  claimRowsFromPolicy,
  claimsListValid,
  mergeClaimRows,
  type ClaimRow,
} from "./claims.tsx";
import type { OidcPolicy } from "../../lib/oidc/policy.ts";

function GitlabIcon({ ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
    </svg>
  );
}

const issuerSchema = z
  .string()
  .min(1, "Enter the instance URL.")
  .regex(/^https:\/\/[^?#\s]+$/, "Enter an https:// URL without query or fragment.");
const namespaceSchema = z.string().min(1, "Enter the group or username.");
const projectSchema = z.string().min(1, "Enter the project.");
const audienceSchema = z.string().min(1, "Enter the audience.");
const scopeSchema = z.enum(["any", "branch", "tag", "environment"]);
const scopeValueSchema = z.string();

type Fields = {
  issuer: z.infer<typeof issuerSchema>;
  namespace: z.infer<typeof namespaceSchema>;
  project: z.infer<typeof projectSchema>;
  audience: z.infer<typeof audienceSchema>;
  scope: z.infer<typeof scopeSchema>;
  scopeValue: z.infer<typeof scopeValueSchema>;
  extraClaims: ClaimRow[];
};
type Scope = Fields["scope"];

const SCOPE_OPTIONS: { label: string; value: Scope }[] = [
  { label: "Any branch or tag", value: "any" },
  { label: "Branch", value: "branch" },
  { label: "Tag", value: "tag" },
  { label: "Environment", value: "environment" },
];

const DEFAULTS: Fields = {
  issuer: "https://gitlab.com",
  namespace: "",
  project: "",
  audience: "",
  scope: "any",
  scopeValue: "",
  extraClaims: [],
};

const FIRST_CLASS_CLAIMS = ["aud", "project_path", "ref", "ref_type", "environment"];

// Turns a pasted GitLab link into a field patch. Self-hosted hosts count
// only when the /-/ marker makes the URL unmistakably GitLab.
function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function parsePastedProject(text: string) {
  const input = text.trim();
  const ssh = input.match(/^git@([\w.-]+):(.+?)(?:\.git)?$/);
  const web = input.match(/^(?:https?:\/\/)?([\w.-]+(?::\d+)?)\/([^?#]+?)(?:[?#].*)?$/);
  const host = ssh?.[1] ?? web?.[1];
  const fullPath = ssh?.[2] ?? web?.[2];
  if (!host || !fullPath) {
    return null;
  }
  if (["github.com", "www.github.com", "bitbucket.org"].includes(host)) {
    return null;
  }
  if (host !== "gitlab.com" && !fullPath.includes("/-/")) {
    return null;
  }
  const cleaned = fullPath.replace(/\.git$/, "");
  const markerIndex = cleaned.indexOf("/-/");
  const projectPath = markerIndex === -1 ? cleaned : cleaned.slice(0, markerIndex);
  const marker = markerIndex === -1 ? "" : cleaned.slice(markerIndex + 3);
  const segments = projectPath.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const patch = {
    issuer: `https://${host}`,
    namespace: segments.slice(0, -1).join("/"),
    project: segments[segments.length - 1] ?? "",
  };
  const tag = marker.match(/^tags\/(.+?)\/?$/);
  if (tag?.[1]) {
    const scopeValue = decodeSegment(tag[1]);
    if (scopeValue !== null) {
      return { ...patch, scope: "tag" as const, scopeValue };
    }
  }
  const branch = marker.match(/^tree\/(.+?)\/?$/);
  if (branch?.[1]) {
    const scopeValue = decodeSegment(branch[1]);
    if (scopeValue !== null) {
      return { ...patch, scope: "branch" as const, scopeValue };
    }
  }
  return patch;
}

// GitLab refs carry no refs/heads prefix; branch vs tag is the ref_type
// claim. The audience is whatever the job requests in its id_tokens config —
// there is no platform default.
function compile(fields: Fields) {
  const claims: Record<string, string[]> = {};
  if (fields.audience) {
    claims.aud = [fields.audience];
  }
  if (fields.namespace && fields.project) {
    claims.project_path = [`${fields.namespace}/${fields.project}`];
  }
  if (fields.scopeValue) {
    if (fields.scope === "branch") {
      claims.ref = [fields.scopeValue];
      claims.ref_type = ["branch"];
    } else if (fields.scope === "tag") {
      claims.ref = [fields.scopeValue];
      claims.ref_type = ["tag"];
    } else if (fields.scope === "environment") {
      claims.environment = [fields.scopeValue];
    }
  }
  mergeClaimRows(claims, fields.extraClaims, FIRST_CLASS_CLAIMS);
  return { issuer: fields.issuer, claims };
}

function parse(policy: OidcPolicy) {
  if (!policy.issuer.startsWith("https://")) {
    return null;
  }
  if (FIRST_CLASS_CLAIMS.some((name) => (policy.claims[name]?.length ?? 0) > 1)) {
    return null;
  }
  const extraClaims = claimRowsFromPolicy(policy.claims, FIRST_CLASS_CLAIMS);
  if (extraClaims === null) {
    return null;
  }

  const [projectPath = ""] = policy.claims.project_path ?? [];
  const segments = projectPath.split("/");
  const project = segments.pop() ?? "";
  const namespace = segments.join("/");
  if (!namespace || !project) {
    return null;
  }

  const [ref] = policy.claims.ref ?? [];
  const [refType] = policy.claims.ref_type ?? [];
  const [environment] = policy.claims.environment ?? [];
  if (ref && environment) {
    return null;
  }
  if (ref && refType !== "branch" && refType !== "tag") {
    return null;
  }
  if (!ref && refType) {
    return null;
  }

  let scope: Scope = "any";
  let scopeValue = "";
  if (ref && refType === "branch") {
    scope = "branch";
    scopeValue = ref;
  } else if (ref && refType === "tag") {
    scope = "tag";
    scopeValue = ref;
  } else if (environment) {
    scope = "environment";
    scopeValue = environment;
  }

  return {
    issuer: policy.issuer,
    namespace,
    project,
    audience: policy.claims.aud?.[0] ?? "",
    scope,
    scopeValue,
    extraClaims,
  };
}

/** True when this form can represent the policy — for routing an edit. */
function matchesGitlabPolicy(policy: OidcPolicy) {
  return parse(policy) !== null;
}

function GitlabPolicyForm({
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
    scope: useStore(form.store, (state) => state.values.scope),
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
      data-slot="gitlab-policy-form"
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
              <FieldLabel htmlFor="gl-issuer" className="w-full">
                Instance <ClaimChip>iss</ClaimChip>
              </FieldLabel>
              <Input
                id="gl-issuer"
                value={field.state.value}
                placeholder="https://gitlab.com"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Keep https://gitlab.com for the hosted service, or enter your self-hosted instance
                URL.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="namespace" validators={{ onChange: namespaceSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="gl-namespace" className="w-full">
                Group or username <ClaimChip>project_path</ClaimChip>
              </FieldLabel>
              <Input
                id="gl-namespace"
                value={field.state.value}
                placeholder="acme"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
                onPaste={(event) => {
                  const patch = parsePastedProject(event.clipboardData.getData("text"));
                  if (!patch) {
                    return;
                  }
                  event.preventDefault();
                  form.reset({ ...form.store.state.values, ...patch }, { keepDefaultValues: true });
                }}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                Subgroups work too: acme/platform. Pasting a GitLab link fills the form.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="project" validators={{ onChange: projectSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="gl-project" className="w-full">
                Project <ClaimChip>project_path</ClaimChip>
              </FieldLabel>
              <Input
                id="gl-project"
                value={field.state.value}
                placeholder="web"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="audience" validators={{ onChange: audienceSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="gl-audience" className="w-full">
                Audience <ClaimChip>aud</ClaimChip>
              </FieldLabel>
              <Input
                id="gl-audience"
                value={field.state.value}
                placeholder="https://your-app.example.com"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                The aud your job requests in its id_tokens config. Pick a value unique to your app.
              </FieldDescription>
            </Field>
          );
        }}
      </form.Field>
      <form.Field name="scope" validators={{ onChange: scopeSchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="gl-scope">Scope by</FieldLabel>
              <Select
                items={SCOPE_OPTIONS}
                value={field.state.value}
                onValueChange={(next) => {
                  field.handleChange((next ?? DEFAULTS.scope) as Scope);
                  form.setFieldValue("scopeValue", "");
                }}
              >
                <SelectTrigger id="gl-scope" className="w-full" aria-invalid={isInvalid}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SCOPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
            </Field>
          );
        }}
      </form.Field>
      {values.scope !== "any" ? (
        <form.Field name="scopeValue" validators={{ onChange: scopeValueSchema }}>
          {(field) => {
            const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor="gl-scopeValue" className="w-full">
                  {values.scope === "branch"
                    ? "Branch name"
                    : values.scope === "tag"
                      ? "Tag name"
                      : "Environment name"}{" "}
                  <ClaimChip>{values.scope === "environment" ? "environment" : "ref"}</ClaimChip>
                </FieldLabel>
                <Input
                  id="gl-scopeValue"
                  value={field.state.value}
                  placeholder={values.scope === "environment" ? "production" : "main"}
                  aria-invalid={isInvalid}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                {isInvalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            );
          }}
        </form.Field>
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

export { GitlabIcon, GitlabPolicyForm, matchesGitlabPolicy };
