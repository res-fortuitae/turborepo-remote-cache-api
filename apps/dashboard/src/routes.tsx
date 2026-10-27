import type { ReactNode } from "react";
import { CapabilitiesPage } from "./pages/CapabilitiesPage.tsx";
import { ProjectPage } from "./pages/project/ProjectPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { GroupsPage } from "./pages/GroupsPage.tsx";
import { MembersPage } from "./pages/MembersPage.tsx";
import { RolesPage } from "./pages/RolesPage.tsx";
import { OnboardingPage } from "./pages/OnboardingPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { PurgePage } from "./pages/PurgePage.tsx";

export interface Route {
  /** Pattern below `/orgs/:org` for org routes, absolute for instance routes. */
  readonly pattern: string;
  readonly title: string;
  readonly render: (params: Readonly<Record<string, string>>) => ReactNode;
}

export const orgRoutes: ReadonlyArray<Route> = [
  { pattern: "", title: "Overview", render: () => <OverviewPage /> },
  { pattern: "/onboarding", title: "Get started", render: () => <OnboardingPage /> },
  { pattern: "/projects", title: "Projects", render: () => <ProjectsPage /> },
  {
    pattern: "/projects/:project",
    title: "Project",
    render: (params) => <ProjectPage key={params.project} projectId={params.project!} />,
  },
  { pattern: "/members", title: "Members", render: () => <MembersPage /> },
  { pattern: "/groups", title: "Groups", render: () => <GroupsPage /> },
  { pattern: "/roles", title: "Roles", render: () => <RolesPage /> },
  { pattern: "/purge", title: "Purge artifacts", render: () => <PurgePage /> },
];

export const instanceRoutes: ReadonlyArray<Route> = [
  { pattern: "/capabilities", title: "Capabilities", render: () => <CapabilitiesPage /> },
];
