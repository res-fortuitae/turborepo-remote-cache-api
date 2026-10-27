import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, LogOut, Menu, Plus } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar";
import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@repo/ui/components/sheet";
import { cn } from "@repo/ui/lib/utils";
import { authClient, type Session } from "../lib/auth-client.ts";
import { navItems, type NavItem } from "../lib/nav.ts";
import { orgPath, useOptionalOrg } from "../lib/org.tsx";
import { href, navigate, splitLocation, useLocation } from "../lib/router.tsx";
import { ElevationBanner } from "./ElevationBanner.tsx";
import { BrandMark } from "./brand.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";

export const isInstanceRole = (role: string | null | undefined) =>
  role === "owner" || role === "admin" || role === "auditor";

function OrgSwitcher() {
  const org = useOptionalOrg();
  const orgs = authClient.useListOrganizations();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="h-auto w-full justify-between gap-2 px-2.5 py-2"
            aria-label="Switch organization"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground font-mono text-[11px] font-semibold text-background"
          >
            {initials(org?.name ?? "?")}
          </span>
          <span className="flex min-w-0 flex-col items-start">
            <span className="truncate text-xs font-medium">
              {org?.name ?? "Choose organization"}
            </span>
            {org ? (
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                TURBO_TEAM={org.slug}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {(orgs.data ?? []).map((item) => (
            <DropdownMenuItem key={item.id} onClick={() => navigate(orgPath(item))}>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.id === org?.id ? <Check aria-label="Current" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/new")}>
          <Plus />
          Create organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ session }: { readonly session: Session }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full" />
        }
      >
        <Avatar className="size-7">
          {session.user.image ? <AvatarImage src={session.user.image} alt="" /> : null}
          <AvatarFallback className="text-[11px]">{initials(session.user.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">
              {session.user.name}
            </span>
            <span className="truncate text-xs font-normal">{session.user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            void authClient.signOut().then(() => {
              navigate("/", { replace: true });
              window.location.reload();
            })
          }
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const itemPath = (item: NavItem, slug: string | undefined) =>
  item.scope === "instance"
    ? item.path
    : slug === undefined
      ? undefined
      : orgPath({ slug }, item.path);

function Navigation({
  session,
  onNavigate,
}: {
  readonly session: Session;
  readonly onNavigate?: () => void;
}) {
  const org = useOptionalOrg();
  const { path: current } = splitLocation(useLocation());
  const role = session.user.role;
  const visible = navItems.filter((item) => item.section !== "Instance" || isInstanceRole(role));
  const sections = [...new Set(visible.map((item) => item.section))];

  // The longest matching prefix wins, so Overview isn't active on every org page.
  const activePath = visible
    .map((item) => itemPath(item, org?.slug))
    .filter(
      (path): path is string =>
        path !== undefined && (current === path || current.startsWith(`${path}/`)),
    )
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-5">
      {sections.map((section) => (
        <div key={section} className="flex flex-col gap-1">
          <p className="px-2.5 pb-1 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
            {section}
          </p>
          {visible
            .filter((item) => item.section === section)
            .map((item) => {
              const path = itemPath(item, org?.slug);

              if (path === undefined) return null;
              const active = path === activePath;

              return (
                <a
                  key={item.label}
                  href={href(path)}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    active && "bg-muted font-medium text-foreground",
                  )}
                >
                  {active ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand"
                    />
                  ) : null}
                  <item.icon className="size-4" aria-hidden="true" />
                  {item.label}
                </a>
              );
            })}
        </div>
      ))}
    </nav>
  );
}

function SidebarBody({
  session,
  onNavigate,
}: {
  readonly session: Session;
  readonly onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <a
        href={href("/")}
        onClick={onNavigate}
        className="flex items-center gap-2.5 px-1 font-semibold tracking-tight"
      >
        <BrandMark className="size-6" />
        Remote Cache
      </a>
      <OrgSwitcher />
      <Navigation session={session} onNavigate={onNavigate} />
    </div>
  );
}

export function AppShell({
  session,
  title,
  banner,
  children,
}: {
  readonly session: Session;
  readonly title: string;
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const org = useOptionalOrg();

  useEffect(() => {
    document.title = `${title} · ${org?.name ?? "Instance"} · Remote Cache`;
  }, [title, org?.name]);

  return (
    <div className="min-h-svh bg-background">
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-primary focus:p-3 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <div className="flex min-h-svh">
        <aside className="sticky top-0 hidden h-svh w-64 shrink-0 overflow-y-auto border-r bg-muted/20 md:block">
          <SidebarBody session={session} />
        </aside>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-72 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarBody session={session} onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <div className="flex min-w-0 flex-1 flex-col">
          {banner}
          <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b bg-background/85 px-4 backdrop-blur md:px-8">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Open navigation"
                onClick={() => setOpen(true)}
              >
                <Menu />
              </Button>
              <span className="truncate text-xs text-muted-foreground">
                {org?.name ?? "Instance"}
              </span>
              <span aria-hidden="true" className="text-border">
                /
              </span>
              <span className="truncate text-xs font-medium">{title}</span>
            </div>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <UserMenu session={session} />
            </div>
          </header>
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 outline-none md:px-8 lg:py-10"
          >
            <ElevationBanner role={session.user.role} />
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
