import { useEffect, useState } from "react";
import { CircleCheck, GitBranch, KeyRound, Laptop, LoaderCircle, ShieldAlert } from "lucide-react";
import { Project, ProjectStorage } from "@repo/shared";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { CodeBlock, ErrorState, PageHeader, formatBytes } from "../components/common.tsx";
import { Stepper } from "../components/stepper.tsx";
import { api } from "../lib/api.ts";
import { createCacheKey, type CreatedCacheKey } from "../lib/cache-keys.ts";
import {
  idsCommand,
  lookupRepository,
  repositoryPattern,
  type GitHubRepository,
} from "../lib/github.ts";
import { orgPath, useOrg, type Org } from "../lib/org.tsx";
import { navigate, splitLocation, useLocation } from "../lib/router.tsx";
import { githubDefaultPolicies, githubWorkflow } from "../lib/trust-policies.ts";
import { useResource } from "../lib/use-resource.ts";
import { slugify } from "./NewOrgPage.tsx";

const steps = ["Organization", "Project", "Connect", "First cache hit"];

const onboardingPath = (org: Pick<Org, "slug">, projectId?: string, step?: string) => {
  const params = new URLSearchParams();

  if (projectId) params.set("project", projectId);

  if (step) params.set("step", step);
  const query = params.toString();

  return orgPath(org, `/onboarding${query ? `?${query}` : ""}`);
};

function CreateProjectStep({ org }: { readonly org: Org }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const effectiveSlug = slug ?? slugify(name);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      const project = await api(`/orgs/${encodeURIComponent(org.id)}/projects`, {
        method: "POST",
        body: { name: name.trim(), slug: effectiveSlug },
        schema: Project,
      });
      navigate(onboardingPath(org, project.id, "connect"), { replace: true });
    } catch (cause) {
      setError(cause);
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Create your first project</CardTitle>
        <CardDescription>
          A project is an isolated cache namespace, usually one monorepo. Credentials and access
          grants are per project.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">Project name</FieldLabel>
              <Input
                id="project-name"
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-slug">Project slug</FieldLabel>
              <Input
                id="project-slug"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxLength={64}
                className="font-mono"
                value={effectiveSlug}
                onChange={(event) => setSlug(event.target.value)}
              />
              <FieldDescription>
                Lowercase letters, numbers and dashes. You can rename it later.
              </FieldDescription>
            </Field>
          </FieldGroup>
          {error === undefined ? null : <ErrorState error={error} />}
          <Button type="submit" disabled={busy || !name.trim() || !effectiveSlug}>
            {busy ? "Creating…" : "Create project"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function GitHubOption({
  org,
  projectId,
  onReady,
}: {
  readonly org: Org;
  readonly projectId: string;
  readonly onReady: () => void;
}) {
  const [repository, setRepository] = useState("");
  const [repo, setRepo] = useState<GitHubRepository>();
  const [manual, setManual] = useState(false);
  const [ids, setIds] = useState({
    repositoryId: "",
    repositoryOwnerId: "",
    defaultBranch: "main",
  });
  const [status, setStatus] = useState<"idle" | "busy" | "saved">("idle");
  const [error, setError] = useState<unknown>();
  const origin = window.location.origin;

  async function lookup() {
    setStatus("busy");
    setError(undefined);

    try {
      setRepo(await lookupRepository(repository.trim()));
    } catch (cause) {
      setError(cause);
      setManual(true);
    } finally {
      setStatus("idle");
    }
  }

  const resolved: GitHubRepository | undefined =
    repo ??
    (manual &&
    repositoryPattern.test(repository.trim()) &&
    /^\d+$/.test(ids.repositoryId) &&
    /^\d+$/.test(ids.repositoryOwnerId) &&
    ids.defaultBranch.trim()
      ? { repository: repository.trim(), ...ids, defaultBranch: ids.defaultBranch.trim() }
      : undefined);

  async function save() {
    if (!resolved) return;
    setStatus("busy");
    setError(undefined);

    try {
      for (const policy of githubDefaultPolicies(resolved, origin))
        await api(`/projects/${encodeURIComponent(projectId)}/trust-policies`, {
          method: "POST",
          body: policy,
        });
      setStatus("saved");
      onReady();
    } catch (cause) {
      setError(cause);
      setStatus("idle");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-6 text-muted-foreground">
        Recommended. The Action exchanges GitHub's OIDC token for a short-lived, project-scoped
        cache token. There is no long-lived secret to leak or rotate.
      </p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="gh-repo">GitHub repository</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="gh-repo"
              placeholder="acme/web"
              className="font-mono"
              value={repository}
              disabled={status !== "idle" || repo !== undefined}
              onChange={(event) => setRepository(event.target.value)}
            />
            {repo ? (
              <Button
                variant="outline"
                onClick={() => {
                  setRepo(undefined);
                  setStatus("idle");
                }}
              >
                Change
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={status !== "idle" || !repository.trim()}
                onClick={() => void lookup()}
              >
                Look up
              </Button>
            )}
          </div>
          <FieldDescription>
            Policies pin the repository's immutable numeric IDs, so a renamed or recreated
            repository can't inherit access.
          </FieldDescription>
        </Field>
        {manual && !repo ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="gh-repo-id">Repository ID</FieldLabel>
              <Input
                id="gh-repo-id"
                inputMode="numeric"
                className="font-mono"
                value={ids.repositoryId}
                onChange={(event) => setIds({ ...ids, repositoryId: event.target.value.trim() })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="gh-owner-id">Owner ID</FieldLabel>
              <Input
                id="gh-owner-id"
                inputMode="numeric"
                className="font-mono"
                value={ids.repositoryOwnerId}
                onChange={(event) =>
                  setIds({ ...ids, repositoryOwnerId: event.target.value.trim() })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="gh-branch">Default branch</FieldLabel>
              <Input
                id="gh-branch"
                className="font-mono"
                value={ids.defaultBranch}
                onChange={(event) => setIds({ ...ids, defaultBranch: event.target.value })}
              />
            </Field>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              Print them with <code className="font-mono">{idsCommand(repository.trim())}</code>
            </p>
          </div>
        ) : null}
      </FieldGroup>
      {resolved ? (
        <div className="flex flex-col gap-3 rounded-md border p-4 text-sm">
          <p className="font-medium">Trust policies to create</p>
          <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
            <li>
              <Badge variant="secondary">read + write</Badge> pushes to{" "}
              <code className="font-mono">{resolved.defaultBranch}</code> in{" "}
              <code className="font-mono">{resolved.repository}</code>
            </li>
            <li>
              <Badge variant="outline">read only</Badge> pull requests in{" "}
              <code className="font-mono">{resolved.repository}</code>
            </li>
          </ul>
          {status === "saved" ? (
            <p className="flex items-center gap-2 text-xs text-success">
              <CircleCheck className="size-4" aria-hidden="true" /> Policies saved.
            </p>
          ) : (
            <Button className="self-start" disabled={status !== "idle"} onClick={() => void save()}>
              Save trust policies
            </Button>
          )}
        </div>
      ) : null}
      {error === undefined ? null : <ErrorState error={error} />}
      {status === "saved" && resolved ? (
        <CodeBlock
          label="Workflow file .github/workflows/ci.yml"
          code={githubWorkflow({
            api: origin,
            orgId: org.id,
            projectId,
            defaultBranch: resolved.defaultBranch,
          })}
        />
      ) : null}
    </div>
  );
}

function CliOption({ org, projectId }: { readonly org: Org; readonly projectId: string }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-6 text-muted-foreground">
        For laptops. <code className="font-mono">tcache login</code> opens a browser approval;
        developer tokens are read-only by default and the proxy keeps them out of your shell.
      </p>
      <CodeBlock
        label="Laptop commands"
        code={`tcache login --api ${window.location.origin}\ntcache link --team ${org.slug} --project ${projectId}\ntcache exec -- turbo run build`}
      />
    </div>
  );
}

function ApiKeyOption({ org, projectId }: { readonly org: Org; readonly projectId: string }) {
  const [created, setCreated] = useState<CreatedCacheKey>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function create() {
    setBusy(true);
    setError(undefined);

    try {
      setCreated(
        await createCacheKey({
          organizationId: org.id,
          projectId,
          name: "Onboarding CI key",
          scope: "read write",
          expiresInDays: 30,
        }),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <ShieldAlert />
        <AlertTitle>Less secure fallback</AlertTitle>
        <AlertDescription>
          An API key is a long-lived secret. Use it only for CI systems that can't issue OIDC
          tokens, store it in your CI's secret manager, and prefer a trust policy when you can.
        </AlertDescription>
      </Alert>
      {created ? (
        <>
          <p className="text-sm">
            Copy this key now. It is shown <strong>once</strong> and expires{" "}
            {created.expiresAt ? new Date(created.expiresAt).toLocaleDateString() : "in 30 days"}.
          </p>
          <CodeBlock label="API key" code={created.key} />
          <CodeBlock
            label="CI environment"
            code={`TURBO_API=${window.location.origin}\nTURBO_TEAM=${org.slug}\nTURBO_TOKEN=<the key above, from your secret store>\n\nbunx turbo run build`}
          />
        </>
      ) : (
        <Button
          variant="outline"
          className="self-start"
          disabled={busy}
          onClick={() => void create()}
        >
          <KeyRound data-icon="inline-start" />
          {busy ? "Creating…" : "Create a 30-day read/write key"}
        </Button>
      )}
      {error === undefined ? null : <ErrorState error={error} />}
    </div>
  );
}

/** Polls the project until the cache reports its first successful read. */
function FirstHitStep({ org, projectId }: { readonly org: Org; readonly projectId: string }) {
  const [tick, setTick] = useState(0);
  const project = useResource(`onboarding-project:${projectId}:${tick}`, (signal) =>
    api(`/projects/${encodeURIComponent(projectId)}`, { schema: Project, signal }),
  );
  const storage = useResource(`onboarding-storage:${projectId}:${tick}`, (signal) =>
    api(`/projects/${encodeURIComponent(projectId)}/storage`, { schema: ProjectStorage, signal }),
  );
  const hit = project.data?.firstHitAt ?? null;

  useEffect(() => {
    if (hit) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 5000);

    return () => window.clearInterval(timer);
  }, [hit]);

  const objects = storage.data?.objects ?? 0;

  return (
    <Card aria-live="polite">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {hit ? (
            <CircleCheck className="size-5 text-success" aria-hidden="true" />
          ) : (
            <LoaderCircle
              className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          {hit
            ? "First cache hit received"
            : objects > 0
              ? "Artifacts uploaded. Waiting for a cache hit…"
              : "Waiting for your first build…"}
        </CardTitle>
        <CardDescription>
          {hit
            ? `${project.data?.name ?? "Your project"} served its first cached artifact on ${new Date(hit).toLocaleString()}.`
            : objects > 0
              ? "Run the same build again, on any connected machine, to restore it from the cache."
              : "Run a build with one of the connection options. This page checks every few seconds."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-6 text-sm">
        <span>
          <span className="text-muted-foreground">Artifacts </span>
          <span className="font-mono">{objects}</span>
        </span>
        <span>
          <span className="text-muted-foreground">Stored </span>
          <span className="font-mono">{formatBytes(storage.data?.bytes ?? 0)}</span>
        </span>
        {hit ? (
          <Button className="ml-auto" onClick={() => navigate(orgPath(org))}>
            Go to dashboard
          </Button>
        ) : null}
      </CardContent>
      {project.status === "error" ? (
        <CardContent>
          <ErrorState error={project.error} />
        </CardContent>
      ) : null}
    </Card>
  );
}

export function OnboardingPage() {
  const org = useOrg();
  const { params } = splitLocation(useLocation());
  const projectId = params.get("project") ?? undefined;
  const step = params.get("step");
  const [connected, setConnected] = useState(false);
  const current = !projectId ? 1 : step === "wait" ? 3 : 2;

  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Connect your first build"
        description={`${org.name} is ready; its team slug is ${org.slug}. Create a project, connect CI or a laptop, then watch for the first cache hit.`}
      />
      <Stepper steps={steps} current={current} />
      {!projectId ? <CreateProjectStep org={org} /> : null}
      {projectId && current === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>How will builds reach the cache?</CardTitle>
            <CardDescription>Pick one now; you can add the others later.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <Tabs defaultValue="github">
              <TabsList aria-label="Connection method">
                <TabsTrigger value="github">
                  <GitBranch data-icon="inline-start" />
                  GitHub Action
                </TabsTrigger>
                <TabsTrigger value="cli">
                  <Laptop data-icon="inline-start" />
                  CLI
                </TabsTrigger>
                <TabsTrigger value="key">
                  <KeyRound data-icon="inline-start" />
                  API key
                </TabsTrigger>
              </TabsList>
              <TabsContent value="github" className="pt-5">
                <GitHubOption org={org} projectId={projectId} onReady={() => setConnected(true)} />
              </TabsContent>
              <TabsContent value="cli" className="pt-5">
                <CliOption org={org} projectId={projectId} />
              </TabsContent>
              <TabsContent value="key" className="pt-5">
                <ApiKeyOption org={org} projectId={projectId} />
              </TabsContent>
            </Tabs>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
              <p className="text-xs text-muted-foreground">
                {connected
                  ? "Commit the workflow, then continue."
                  : "Set up a connection, then continue."}
              </p>
              <Button onClick={() => navigate(onboardingPath(org, projectId, "wait"))}>
                Continue
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {projectId && current === 3 ? <FirstHitStep org={org} projectId={projectId} /> : null}
    </>
  );
}
