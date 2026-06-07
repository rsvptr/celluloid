"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Command as CommandIcon,
  Download,
  Film,
  LogOut,
  Plus,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { LayoutGroup, motion, MotionProvider } from "@/components/motion";
import { Wordmark } from "./brand";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Library", icon: Film },
  { href: "/add", label: "Add", icon: Plus },
  { href: "/recommend", label: "Recommend", icon: Sparkles },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/export", label: "Export", icon: Download },
];

export function Nav({ userName }: { userName?: string | null }) {
  const pathname = usePathname();
  const router = useRouter();

  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/" || pathname.startsWith("/title")
      : pathname.startsWith(href);

  async function handleSignOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  function openCommand() {
    window.dispatchEvent(new Event("celluloid:command"));
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4">
        <Wordmark size={28} textClassName="hidden sm:inline" />
        <MotionProvider>
          <LayoutGroup>
            <nav className="ml-3 flex items-center gap-1">
              {LINKS.map((l) => {
                const Icon = l.icon;
                const active = isActive(l.href);
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={cn(
                      "focus-ring relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                      active
                        ? "text-foreground"
                        : "text-muted hover:bg-surface-2/60 hover:text-foreground",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        className="absolute inset-0 -z-10 rounded-lg bg-surface-2"
                        transition={{ type: "spring", stiffness: 400, damping: 32 }}
                      />
                    )}
                    <Icon size={16} />
                    <span className="hidden sm:inline">{l.label}</span>
                  </Link>
                );
              })}
            </nav>
          </LayoutGroup>
        </MotionProvider>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={openCommand}
            title="Search (⌘K)"
            aria-label="Search"
            className="focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground"
          >
            <Search size={15} />
            <span className="hidden items-center gap-0.5 text-xs text-faint lg:flex">
              <CommandIcon size={11} />K
            </span>
          </button>
          {userName && (
            <span className="hidden text-sm text-muted md:inline">{userName}</span>
          )}
          <Link
            href="/settings"
            title="Settings"
            aria-label="Settings"
            className={cn(
              "focus-ring flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
              pathname.startsWith("/settings")
                ? "bg-surface-2 text-foreground"
                : "text-muted hover:bg-surface-2/60 hover:text-foreground",
            )}
          >
            <Settings size={16} />
          </Link>
          <button
            onClick={handleSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
