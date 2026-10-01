"use client";

import { useEffect } from "react";
import {
  LayoutDashboard,
  BarChart3,
  Plug,
  BriefcaseBusiness,
  Users,
  Settings,
  Sun,
  Moon,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useSocialFlow, type AppView } from "@/lib/store";
import { useTheme } from "next-themes";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  action: () => void;
  group: "navigation" | "create" | "settings";
}

/**
 * CommandPalette — a cmdk-powered command palette opened with ⌘K. Lets
 * power users jump between views, create a new post, toggle the theme
 * or sign out without touching the mouse.
 */
export function CommandPalette() {
  const { commandOpen, setCommandOpen, setActiveView, signOut, workspaces, workspaceId } = useSocialFlow();
  const role = workspaces.find((workspace) => workspace.id === workspaceId)?.role;
  const canManageTeam = role === "owner" || role === "admin";
  const { theme, setTheme } = useTheme();

  // Keyboard shortcut: ⌘K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen(!commandOpen);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commandOpen, setCommandOpen]);

  const goTo = (view: AppView) => {
    setActiveView(view);
    setCommandOpen(false);
  };

  const commands: Command[] = [
    // Navigation
    { id: "nav-dashboard", label: "Go to Dashboard", icon: LayoutDashboard, action: () => goTo("dashboard"), group: "navigation" },
    { id: "nav-analytics", label: "Go to Analytics", icon: BarChart3, action: () => goTo("analytics"), group: "navigation" },
    { id: "nav-accounts", label: "Go to Accounts", icon: Plug, action: () => goTo("accounts"), group: "navigation" },
    { id: "nav-clients", label: "Go to Clients", icon: BriefcaseBusiness, action: () => goTo("clients"), group: "navigation" },
    { id: "nav-settings", label: "Go to Settings", icon: Settings, action: () => goTo("settings"), group: "navigation" },
    // Settings
    {
      id: "toggle-theme",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: theme === "dark" ? Sun : Moon,
      action: () => {
        setTheme(theme === "dark" ? "light" : "dark");
        setCommandOpen(false);
      },
      group: "settings",
    },
    {
      id: "sign-out",
      label: "Sign out",
      icon: LogOut,
      action: () => {
        signOut();
        setCommandOpen(false);
      },
      group: "settings",
    },
  ];

  if (canManageTeam) {
    const settingsIndex = commands.findIndex((command) => command.id === "nav-settings");
    commands.splice(settingsIndex < 0 ? commands.length : settingsIndex, 0, {
      id: "nav-team",
      label: "Go to Team",
      icon: Users,
      action: () => goTo("team"),
      group: "navigation",
    });
  }

  const groups: { label: string; group: Command["group"] }[] = [
    { label: "Navigation", group: "navigation" },
    { label: "Settings", group: "settings" },
  ];

  return (
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map((g) => {
          const items = commands.filter((c) => c.group === g.group);
          if (items.length === 0) return null;
          return (
            <CommandGroup key={g.group} heading={g.label}>
              {items.map((c) => (
                <CommandItem key={c.id} value={`${c.label} ${c.hint ?? ""}`} onSelect={c.action}>
                  <c.icon className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">{c.label}</span>
                  {c.hint && (
                    <span className="text-xs text-muted-foreground">{c.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
