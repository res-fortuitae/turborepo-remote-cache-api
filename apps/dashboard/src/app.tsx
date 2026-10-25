import { CapabilitiesPage } from "./CapabilitiesPage.tsx";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  GitBranch,
  Layers,
  Moon,
  Sun,
  Terminal,
  Zap,
} from "lucide-react";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Separator } from "@repo/ui/components/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";

const guide = "https://github.com/StvyaSharma/turborepo-remote-cache-api#use-it-from-turborepo";

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    setDark(next);

    try {
      localStorage.setItem("remote-cache-theme", next ? "dark" : "light");
    } catch {
      // A blocked storage write should not prevent switching themes.
    }
  }

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      onClick={toggle}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const messages = {
    idle: "",
    copied: "Copied to clipboard.",
    failed: "Copy unavailable. Select and copy the text instead.",
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={copy} aria-label={label}>
        {status === "copied" ? (
          <Check data-icon="inline-start" />
        ) : (
          <Copy data-icon="inline-start" />
        )}
        {status === "copied" ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {messages[status]}
      </span>
    </div>
  );
}

function CommandPanel({ command }: { readonly command: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 pt-4">
      <pre
        tabIndex={0}
        aria-label="Cache setup commands"
        className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-7 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <code>{command}</code>
      </pre>
      <CopyButton text={command} label="Copy setup commands" />
    </div>
  );
}

export function App() {
  const [page, setPage] = useState(() =>
    window.location.hash === "#capabilities" ? "capabilities" : "setup",
  );

  useEffect(() => {
    const update = () =>
      setPage(window.location.hash === "#capabilities" ? "capabilities" : "setup");

    window.addEventListener("hashchange", update);

    return () => window.removeEventListener("hashchange", update);
  }, []);
  const origin = window.location.origin;
  const localCommand = `export TURBO_API=${origin}\nexport TURBO_TOKEN='<your-token>'\nexport TURBO_TEAM='<your-team>'\n\nbunx turbo run build`;
  const ciCommand = `- name: Build with remote cache\n  run: bunx turbo run build\n  env:\n    TURBO_API: ${origin}\n    TURBO_TOKEN: \u0024{{ secrets.TURBO_TOKEN }}\n    TURBO_TEAM: \u0024{{ vars.TURBO_TEAM }}`;

  return (
    <div className="min-h-svh bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:rounded-md focus:bg-primary focus:p-3 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <div className="mx-auto flex min-h-svh max-w-[1600px] flex-col md:flex-row">
        <aside className="flex shrink-0 flex-col gap-6 border-b bg-muted/25 p-5 md:w-56 md:border-r md:border-b-0 md:p-6">
          <a href="#connect" className="flex items-center gap-2.5 font-semibold tracking-tight">
            <Layers className="size-5" aria-hidden="true" />
            Remote Cache
          </a>
          <nav aria-label="Workspace" className="flex gap-2 md:flex-col">
            <Button
              variant={page === "setup" ? "secondary" : "ghost"}
              className="justify-start"
              render={<a href="#connect" />}
              nativeButton={false}
            >
              <Terminal data-icon="inline-start" />
              Workspace setup
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              render={<a href="#basics" />}
              nativeButton={false}
            >
              <Zap data-icon="inline-start" />
              Cache basics
            </Button>
            <Button
              variant={page === "capabilities" ? "secondary" : "ghost"}
              className="justify-start"
              render={<a href="#capabilities" />}
              nativeButton={false}
            >
              Capabilities
            </Button>
          </nav>
          <div className="hidden flex-1 md:block" />
          <div className="hidden flex-col gap-3 md:flex">
            <Separator />
            <p className="text-xs leading-5 text-muted-foreground">
              Your infrastructure.
              <br />
              Faster builds, shared.
            </p>
            <Button
              variant="link"
              className="justify-start px-0"
              render={<a href={guide} target="_blank" rel="noreferrer" />}
              nativeButton={false}
            >
              Read the guide
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="flex h-16 items-center justify-between gap-3 border-b px-6 lg:px-10">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Workspace</span>
              <span aria-hidden="true" className="text-border">
                /
              </span>
              <span className="text-xs font-medium">
                {page === "capabilities" ? "Capabilities" : "Setup"}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant="outline">Getting started</Badge>
              <ThemeToggle />
            </div>
          </header>
          <main
            id="main"
            className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-10 lg:px-10 lg:py-16"
          >
            {page === "capabilities" ? (
              <CapabilitiesPage />
            ) : (
              <>
                <section
                  id="connect"
                  aria-labelledby="connect-title"
                  className="flex flex-col gap-8"
                >
                  <div className="flex flex-col gap-3">
                    <p className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
                      Build once. Reuse everywhere.
                    </p>
                    <h1
                      id="connect-title"
                      className="text-3xl font-semibold tracking-tight sm:text-4xl"
                    >
                      Connect your cache
                    </h1>
                    <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                      Share build artifacts across your team and CI. Start with your cache URL, then
                      connect a Turborepo workspace.
                    </p>
                  </div>
                  <div className="grid items-start gap-8 lg:grid-cols-[1fr_1.65fr]">
                    <ol className="flex flex-col gap-7" aria-label="Connection steps">
                      {[
                        {
                          title: "Use your cache URL",
                          detail:
                            "Point Turborepo at this instance. Your team and CI use the same endpoint.",
                        },
                        {
                          title: "Add your credentials",
                          detail:
                            "Use your cache token and team identifier. Store CI tokens in your secret manager.",
                        },
                        {
                          title: "Run your first build",
                          detail:
                            "Run the same build twice. The second run can restore its outputs from the cache.",
                        },
                      ].map((step, index) => (
                        <li key={step.title} className="flex gap-3">
                          <span
                            className="flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] text-muted-foreground"
                            aria-hidden="true"
                          >
                            {index + 1}
                          </span>
                          <div className="flex flex-col gap-1">
                            <h2 className="text-sm font-medium">{step.title}</h2>
                            <p className="text-xs leading-5 text-muted-foreground">{step.detail}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                    <Card>
                      <CardHeader>
                        <CardTitle>Connect a workspace</CardTitle>
                        <CardDescription>
                          Run locally or add the configuration to your build workflow.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex min-w-0 flex-col gap-5">
                        <div className="flex flex-col gap-2">
                          <span className="text-xs font-medium">Cache URL</span>
                          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2">
                            <code className="min-w-0 break-all font-mono text-xs">{origin}</code>
                            <CopyButton text={origin} label="Copy cache URL" />
                          </div>
                        </div>
                        <Tabs defaultValue="local">
                          <TabsList aria-label="Connection environment">
                            <TabsTrigger value="local">
                              <Terminal data-icon="inline-start" />
                              Local development
                            </TabsTrigger>
                            <TabsTrigger value="ci">
                              <GitBranch data-icon="inline-start" />
                              GitHub Actions
                            </TabsTrigger>
                          </TabsList>
                          <TabsContent value="local">
                            <CommandPanel command={localCommand} />
                          </TabsContent>
                          <TabsContent value="ci">
                            <CommandPanel command={ciCommand} />
                          </TabsContent>
                        </Tabs>
                      </CardContent>
                      <CardFooter>
                        <p className="text-xs leading-5 text-muted-foreground">
                          Replace the placeholders with your credentials. Never commit a cache token
                          to your repository.
                        </p>
                      </CardFooter>
                    </Card>
                  </div>
                </section>
                <Separator />
                <section id="basics" aria-labelledby="basics-title" className="flex flex-col gap-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 id="basics-title" className="text-lg font-semibold tracking-tight">
                      A shorter path to a finished build
                    </h2>
                    <Button
                      variant="link"
                      render={
                        <a
                          href="https://turborepo.dev/docs/core-concepts/remote-caching"
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                      nativeButton={false}
                    >
                      How remote caching works
                      <ArrowUpRight data-icon="inline-end" />
                    </Button>
                  </div>
                  <div className="grid gap-6 sm:grid-cols-3">
                    {[
                      {
                        title: "One shared result",
                        detail:
                          "A teammate or CI can reuse the outputs of a task that already ran.",
                      },
                      {
                        title: "Content, not timestamps",
                        detail:
                          "Turborepo hashes task inputs to find the matching build artifacts.",
                      },
                      {
                        title: "Your storage, your control",
                        detail:
                          "Artifacts live in your Cloudflare account, with retention set by your organization.",
                      },
                    ].map((item) => (
                      <div key={item.title} className="flex flex-col gap-2">
                        <h3 className="text-xs font-medium">{item.title}</h3>
                        <p className="text-xs leading-5 text-muted-foreground">{item.detail}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}
            <footer className="flex flex-wrap items-center justify-between gap-3 pt-4 text-xs text-muted-foreground">
              <span>Turborepo Remote Cache</span>
              <span>Built for the work you have already done.</span>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}
