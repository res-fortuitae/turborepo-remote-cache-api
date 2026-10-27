import { useState } from "react";
import { Button } from "@repo/ui/components/button";
import { BrandMark, GitHubMark } from "../components/brand.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { errorMessage } from "../lib/api.ts";
import { signInWithGitHub } from "../lib/auth-client.ts";

export function SignInPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function signIn() {
    setBusy(true);
    setError(undefined);

    try {
      await signInWithGitHub();
    } catch (cause) {
      setError(cause);
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-[1.1fr_1fr]">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <section
        aria-hidden="true"
        className="relative hidden overflow-hidden border-r bg-muted/30 lg:flex lg:flex-col lg:justify-between lg:p-12"
      >
        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <BrandMark className="size-6" />
          Remote Cache
        </div>
        <pre className="font-mono text-xs leading-7 text-muted-foreground">
          {`$ turbo run build
• Packages in scope: web, docs, ui
• Running build in 3 packages
web:build: cache hit, replaying logs 4f2a9c…
docs:build: cache hit, replaying logs 9b11e0…
ui:build: cache hit, replaying logs c03d7a…

 Tasks:    3 successful, 3 total
Cached:    3 cached, 3 total
  Time:    412ms `}
          <span className="font-semibold text-brand">&gt;&gt;&gt; FULL TURBO</span>
        </pre>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">
          Your Turborepo cache, on your Cloudflare account. Short-lived CI credentials, per-project
          access, and an audit trail for every change.
        </p>
      </section>
      <main className="flex items-center justify-center p-6">
        <div className="flex w-full max-w-sm flex-col gap-8">
          <div className="flex flex-col gap-3">
            <BrandMark className="size-8 lg:hidden" />
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to your cache</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              Use the GitHub account your instance administrator allows. The first person to sign in
              to a new instance becomes its owner.
            </p>
          </div>
          <Button size="lg" disabled={busy} onClick={() => void signIn()}>
            <GitHubMark className="size-4" />
            {busy ? "Redirecting to GitHub…" : "Continue with GitHub"}
          </Button>
          <p role="status" className="text-sm text-destructive">
            {error === undefined ? "" : errorMessage(error)}
          </p>
        </div>
      </main>
    </div>
  );
}
