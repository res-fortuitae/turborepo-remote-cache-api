import { useEffect, useState } from "react";
import { CapabilityReport } from "@repo/shared";
import * as Schema from "effect/Schema";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";

const decodeCapabilities = Schema.decodeUnknownSync(CapabilityReport);
const capabilityKeys = ["emailSending", "analytics", "auditHistory", "directUploads"] as const;

const labels = {
  emailSending: "Transactional email",
  analytics: "Analytics history",
  auditHistory: "Audit history",
  directUploads: "Uploads over 100 MB",
} as const;

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "loaded"; readonly report: CapabilityReport };

export function CapabilitiesPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    async function load() {
      try {
        const response = await fetch("/api/instance/capabilities", {
          credentials: "same-origin",
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          setState({
            status: "error",
            message:
              response.status === 401
                ? "Sign in to this instance to view its capabilities."
                : "Capabilities are unavailable. Check your connection and try again.",
          });

          return;
        }

        const report = decodeCapabilities(await response.json());
        setState({ status: "loaded", report });
      } catch {
        if (!controller.signal.aborted)
          setState({
            status: "error",
            message: "Capabilities are unavailable. Check your connection and try again.",
          });
      }
    }

    void load();

    return () => controller.abort();
  }, [attempt]);

  return (
    <section id="capabilities" aria-labelledby="capabilities-title" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 id="capabilities-title" className="text-3xl font-semibold tracking-tight">
          Instance capabilities
        </h1>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground">
          See what this instance supports, the fallback in use, and what an upgrade would unlock.
        </p>
      </div>
      {state.status === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading capabilities…
        </p>
      )}
      {state.status === "error" && (
        <Card>
          <CardHeader>
            <CardTitle>Unable to load capabilities</CardTitle>
            <CardDescription>{state.message}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}
      {state.status === "loaded" && (
        <>
          <div className="flex flex-wrap gap-2" aria-label="Detected plans">
            <Badge variant="outline">Workers: {state.report.workersPlan}</Badge>
            <Badge variant="outline">Zone: {state.report.zonePlan}</Badge>
            <Badge variant="secondary">Analytics: {state.report.analyticsMode}</Badge>
          </div>
          {state.report.warnings.map((warning) => (
            <p key={warning} role="status" className="text-sm text-muted-foreground">
              {warning}
            </p>
          ))}
          <div className="grid gap-4 sm:grid-cols-2">
            {capabilityKeys.map((key) => {
              const feature = state.report[key];

              return (
                <Card key={key}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle>{labels[key]}</CardTitle>
                      <Badge variant={feature.enabled ? "default" : "secondary"}>
                        {feature.enabled ? "On" : "Fallback"}
                      </Badge>
                    </div>
                    <CardDescription>{feature.reason}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <div>
                      <h2 className="text-xs font-medium">Fallback</h2>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {feature.fallback}
                      </p>
                    </div>
                    <div>
                      <h2 className="text-xs font-medium">What unlocks more</h2>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {feature.upgrade}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Audit hot window: {state.report.auditRetentionDays} days. Unexported events remain in
            D1. Changes to your plan or feature settings take effect after redeploying.
          </p>
        </>
      )}
    </section>
  );
}
