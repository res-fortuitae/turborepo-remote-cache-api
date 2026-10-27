import type { ReactNode } from "react";
import { useEffect } from "react";
import { Compass } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import { BrandMark } from "./components/brand.tsx";
import { EmptyState, ErrorState } from "./components/common.tsx";
import { AppShell } from "./components/shell.tsx";
import { authClient, type Session } from "./lib/auth-client.ts";
import { OrgProvider, orgPath } from "./lib/org.tsx";
import { href, matchRoute, navigate, splitLocation, useLocation } from "./lib/router.tsx";
import { DevicePage } from "./pages/DevicePage.tsx";
import { NewOrgPage } from "./pages/NewOrgPage.tsx";
import { SignInPage } from "./pages/SignInPage.tsx";
import { instanceRoutes, orgRoutes } from "./routes.tsx";

function Splash() {
  return (
    <div className="flex min-h-svh items-center justify-center" aria-busy="true">
      <BrandMark className="size-8 animate-pulse text-muted-foreground" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function Redirect({ to }: { readonly to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);

  return null;
}

function NotFound({ session }: { readonly session: Session }) {
  return (
    <AppShell session={session} title="Not found">
      <EmptyState
        icon={<Compass />}
        title="This page doesn't exist"
        description="It may have moved, or you may not have access to it."
        action={
          <Button render={<a href={href("/")} />} nativeButton={false}>
            Go to dashboard
          </Button>
        }
      />
    </AppShell>
  );
}

/** Resolves `/orgs/:slug/*` against the signed-in user's organizations. */
function OrgArea({
  session,
  slug,
  rest,
}: {
  readonly session: Session;
  readonly slug: string;
  readonly rest: string;
}) {
  const orgs = authClient.useListOrganizations();

  if (orgs.isPending && !orgs.data) return <Splash />;

  if (orgs.error)
    return (
      <AppShell session={session} title="Organization">
        <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />
      </AppShell>
    );
  const org = orgs.data?.find((item) => item.slug === slug);

  if (!org) return <NotFound session={session} />;

  for (const route of orgRoutes) {
    const params = matchRoute(route.pattern || "/", rest || "/");

    if (params)
      return (
        <OrgProvider key={org.id} org={{ id: org.id, slug: org.slug, name: org.name }}>
          <AppShell session={session} title={route.title}>
            {route.render(params)}
          </AppShell>
        </OrgProvider>
      );
  }

  return (
    <OrgProvider key={org.id} org={{ id: org.id, slug: org.slug, name: org.name }}>
      <NotFound session={session} />
    </OrgProvider>
  );
}

function Home({ session }: { readonly session: Session }) {
  const orgs = authClient.useListOrganizations();
  const active = session.session.activeOrganizationId;

  if (orgs.isPending && !orgs.data) return <Splash />;
  const list = orgs.data ?? [];
  const target = list.find((org) => org.id === active) ?? list[0];

  return <Redirect to={target ? orgPath(target) : "/new"} />;
}

function SignedIn({ session, path }: { readonly session: Session; readonly path: string }) {
  if (path === "/") return <Home session={session} />;

  if (path === "/new")
    return (
      <AppShell session={session} title="New organization">
        <NewOrgPage />
      </AppShell>
    );
  const org = /^\/orgs\/([^/]+)(\/.*)?$/.exec(path);

  if (org?.[1]) {
    let slug: string;

    try {
      slug = decodeURIComponent(org[1]);
    } catch {
      return <NotFound session={session} />;
    }

    return <OrgArea session={session} slug={slug} rest={org[2] ?? ""} />;
  }

  for (const route of instanceRoutes) {
    const params = matchRoute(route.pattern, path);

    if (params)
      return (
        <AppShell session={session} title={route.title}>
          {route.render(params)}
        </AppShell>
      );
  }

  return <NotFound session={session} />;
}

function Standalone({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-8 bg-background p-6">
      <a href={href("/")} className="flex items-center gap-2.5 font-semibold tracking-tight">
        <BrandMark className="size-6" />
        Remote Cache
      </a>
      <main className="w-full max-w-xl">{children}</main>
    </div>
  );
}

export function App() {
  const location = useLocation();
  const session = authClient.useSession();
  const { path } = splitLocation(location);

  // The CLI prints `/device`; `/?view=device` remains for older clients.
  if (
    window.location.pathname === "/device" ||
    new URLSearchParams(window.location.search).get("view") === "device"
  )
    return (
      <Standalone>
        <DevicePage />
      </Standalone>
    );

  if (session.isPending && !session.data) return <Splash />;

  if (!session.data) return <SignInPage />;

  return <SignedIn session={session.data} path={path} />;
}
