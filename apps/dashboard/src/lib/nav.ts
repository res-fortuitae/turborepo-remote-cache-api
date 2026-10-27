import type { LucideIcon } from "lucide-react";
import { Gauge, Settings2, Trash2 } from "lucide-react";

export interface NavItem {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Path below `/orgs/:slug`, or an absolute path when `scope` is `instance`. */
  readonly path: string;
  readonly section: "Workspace" | "Security" | "Insights" | "Instance";
  readonly scope?: "org" | "instance";
}

/** Sidebar entries in display order. */
export const navItems: ReadonlyArray<NavItem> = [
  { label: "Overview", icon: Gauge, path: "", section: "Workspace" },
  { label: "Purge artifacts", icon: Trash2, path: "/purge", section: "Security" },
  {
    label: "Capabilities",
    icon: Settings2,
    path: "/capabilities",
    section: "Instance",
    scope: "instance",
  },
];
