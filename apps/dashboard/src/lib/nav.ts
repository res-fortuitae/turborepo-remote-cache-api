import type { LucideIcon } from "lucide-react";
import {
  FolderGit2,
  KeyRound,
  Gauge,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  UsersRound,
} from "lucide-react";

export interface NavItem {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Path below `/orgs/:slug`, or an absolute path when `scope` is `instance`. */
  readonly path: string;
  readonly section: "Workspace" | "Organization" | "Security" | "Insights" | "Instance";
  readonly scope?: "org" | "instance";
}

/** Sidebar entries in display order. */
export const navItems: ReadonlyArray<NavItem> = [
  { label: "Overview", icon: Gauge, path: "", section: "Workspace" },
  { label: "Projects", icon: FolderGit2, path: "/projects", section: "Workspace" },
  { label: "Members", icon: Users, path: "/members", section: "Organization" },
  { label: "Groups", icon: UsersRound, path: "/groups", section: "Organization" },
  { label: "Roles", icon: ShieldCheck, path: "/roles", section: "Organization" },
  { label: "Credentials", icon: KeyRound, path: "/credentials", section: "Security" },
  { label: "Purge artifacts", icon: Trash2, path: "/purge", section: "Security" },
  {
    label: "Capabilities",
    icon: Settings2,
    path: "/capabilities",
    section: "Instance",
    scope: "instance",
  },
];
