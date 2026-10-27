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

function GithubIcon({ ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const repositorySchema = z
  .string()
  .min(1, "Enter the repository.")
  .regex(
    /^(?:(?:https?:\/\/)?github\.com[\/:]|git@github\.com:)?[A-Za-z0-9-]+\/[\w.-]+?(?:\.git)?\/?$/,
    "Use owner/repo or paste the repository URL.",
  );
const scopeSchema = z.enum(["any", "branch", "tag", "environment"]);
const scopeValueSchema = z.string();

type Fields = {
  repository: z.infer<typeof repositorySchema>;
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
  repository: "",
  scope: "any",
  scopeValue: "",
  extraClaims: [],
};

const FIRST_CLASS_CLAIMS = ["aud", "repository", "ref", "environment"];

const ISSUER = "https://token.actions.githubusercontent.com";

// Paths under these are GitHub product pages, never repositories.
const RESERVED_OWNERS = [
  "orgs",
  "features",
  "topics",
  "collections",
  "marketplace",
  "sponsors",
  "apps",
  "settings",
  "explore",
  "enterprise",
];

// Accepts owner/repo, a pasted repository URL, or an SSH remote.
function parseRepository(input: string) {
  const match = input
    .trim()
    .match(
      /^(?:(?:https?:\/\/)?github\.com[/:]|git@github\.com:)?([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
    );
  if (!match || !match[1] || !match[2] || RESERVED_OWNERS.includes(match[1])) {
    return null;
  }
  return { owner: match[1], repo: match[2] };
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// Turns any pasted GitHub link into a field patch: repo pages, tree and
// release URLs (which also set the scope), clone URLs, or plain owner/repo.
function parsePastedRepository(text: string) {
  const url = text
    .trim()
    .match(
      /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?(?:\/([^?#]*))?(?:[?#].*)?$/,
    );
  if (!url) {
    const repository = parseRepository(text);
    return repository ? { repository: `${repository.owner}/${repository.repo}` } : null;
  }
  const [, owner = "", repo = "", rawPath = ""] = url;
  if (RESERVED_OWNERS.includes(owner)) {
    return null;
  }
  const repository = `${owner}/${repo}`;
  const path = rawPath.replace(/\/$/, "");
  const tag = path.match(/^releases\/tag\/(.+)$/);
  if (tag?.[1]) {
    const scopeValue = decodeSegment(tag[1]);
    if (scopeValue !== null) {
      return { repository, scope: "tag" as const, scopeValue };
    }
  }
  const branch = path.match(/^tree\/(.+)$/);
  if (branch?.[1]) {
    const scopeValue = decodeSegment(branch[1]);
    if (scopeValue !== null) {
      return { repository, scope: "branch" as const, scopeValue };
    }
  }
  return { repository };
}

function compile(fields: Fields) {
  const claims: Record<string, string[]> = {};
  const repository = parseRepository(fields.repository);
  if (repository) {
    claims.aud = [`https://github.com/${repository.owner}`];
    claims.repository = [`${repository.owner}/${repository.repo}`];
  }
  if (fields.scopeValue) {
    if (fields.scope === "branch") {
      claims.ref = [`refs/heads/${fields.scopeValue}`];
    } else if (fields.scope === "tag") {
      claims.ref = [`refs/tags/${fields.scopeValue}`];
    } else if (fields.scope === "environment") {
      claims.environment = [fields.scopeValue];
    }
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

  const [repository = ""] = policy.claims.repository ?? [];
  const parsed = parseRepository(repository);
  if (!parsed || `${parsed.owner}/${parsed.repo}` !== repository) {
    return null;
  }

  const [aud] = policy.claims.aud ?? [];
  if (aud !== `https://github.com/${parsed.owner}`) {
    return null;
  }

  const [ref] = policy.claims.ref ?? [];
  const [environment] = policy.claims.environment ?? [];
  if (ref && environment) {
    return null;
  }

  let scope: Scope = "any";
  let scopeValue = "";
  if (ref?.startsWith("refs/heads/")) {
    scope = "branch";
    scopeValue = ref.slice("refs/heads/".length);
  } else if (ref?.startsWith("refs/tags/")) {
    scope = "tag";
    scopeValue = ref.slice("refs/tags/".length);
  } else if (ref) {
    return null;
  } else if (environment) {
    scope = "environment";
    scopeValue = environment;
  }
  if (ref && !scopeValue) {
    return null;
  }

  return { repository, scope, scopeValue, extraClaims };
}

/** True when this form can represent the policy — for routing an edit. */
function matchesGithubPolicy(policy: OidcPolicy) {
  return parse(policy) !== null;
}

function GithubPolicyForm({
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
      if (!(claimsListValid(fields.extraClaims) && parseRepository(fields.repository) !== null)) {
        return;
      }
      const policy = compile(fields);
      onSubmit(defaultValue?.label ? { ...policy, label: defaultValue.label } : policy);
    },
  });
  const values = {
    repository: useStore(form.store, (state) => state.values.repository),
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
      data-slot="github-policy-form"
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <Field>
        <FieldLabel htmlFor="gh-issuer" className="w-full">
          Issuer <ClaimChip>iss</ClaimChip>
        </FieldLabel>
        <Input id="gh-issuer" value={ISSUER} readOnly disabled />
        <FieldDescription>Fixed for GitHub Actions.</FieldDescription>
      </Field>
      <form.Field name="repository" validators={{ onChange: repositorySchema }}>
        {(field) => {
          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor="gh-repository" className="w-full">
                Repository <ClaimChip>aud · repository</ClaimChip>
              </FieldLabel>
              <Input
                id="gh-repository"
                value={field.state.value}
                placeholder="acme/web"
                aria-invalid={isInvalid}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.trim())}
                onPaste={(event) => {
                  const patch = parsePastedRepository(event.clipboardData.getData("text"));
                  if (!patch) {
                    return;
                  }
                  event.preventDefault();
                  form.reset({ ...form.store.state.values, ...patch }, { keepDefaultValues: true });
                }}
              />
              {isInvalid && <FieldError errors={field.state.meta.errors} />}
              <FieldDescription>
                owner/repo — or paste any GitHub link to fill the form.
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
              <FieldLabel htmlFor="gh-scope">Scope by</FieldLabel>
              <Select
                items={SCOPE_OPTIONS}
                value={field.state.value}
                onValueChange={(next) => {
                  field.handleChange((next ?? DEFAULTS.scope) as Scope);
                  form.setFieldValue("scopeValue", "");
                }}
              >
                <SelectTrigger id="gh-scope" className="w-full" aria-invalid={isInvalid}>
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
                <FieldLabel htmlFor="gh-scopeValue" className="w-full">
                  {values.scope === "branch"
                    ? "Branch name"
                    : values.scope === "tag"
                      ? "Tag name"
                      : "Environment name"}{" "}
                  <ClaimChip>{values.scope === "environment" ? "environment" : "ref"}</ClaimChip>
                </FieldLabel>
                <Input
                  id="gh-scopeValue"
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
      {parseRepository(values.repository)?.owner ? (
        <FieldDescription>
          Audience derived automatically:{" "}
          <span className="font-mono">
            https://github.com/{parseRepository(values.repository)?.owner}
          </span>
        </FieldDescription>
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

export { GithubIcon, GithubPolicyForm, matchesGithubPolicy };
