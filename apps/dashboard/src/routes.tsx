import type { ReactNode } from "react";
import { CapabilitiesPage } from "./pages/CapabilitiesPage.tsx";
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
  { pattern: "/purge", title: "Purge artifacts", render: () => <PurgePage /> },
];

export const instanceRoutes: ReadonlyArray<Route> = [
  { pattern: "/capabilities", title: "Capabilities", render: () => <CapabilitiesPage /> },
];
