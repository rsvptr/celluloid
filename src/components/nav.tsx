"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  CalendarClock,
  Command as CommandIcon,
  Download,
  Film,
  LogOut,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import {
  AnimatePresence,
  EASE_OUT,
  LayoutGroup,
  motion,
} from "@/components/motion";
import { Wordmark } from "./brand";
import { cn } from "@/lib/utils";

const subscribeNoop = () => () => {};

const LINKS = [
  { href: "/", label: "Library", icon: Film },
  { href: "/add", label: "Add", icon: Plus },
  // "Airing", not "Airing soon": this label also renders in the mobile tab bar,
  // where five targets share a 320px row and the longest one sets the squeeze.
  { href: "/upcoming", label: "Airing", icon: CalendarClock },
  { href: "/recommend", label: "Recommend", icon: Sparkles },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/export", label: "Export", icon: Download },
];

// The fixed mobile tab bar surfaces the primary destinations — Export moves
// into the "More" popover alongside Settings/Sign out, since it is the one
// entry that is a task rather than a place you check.
const BOTTOM_LINKS = LINKS.filter((l) => l.href !== "/export");

export function Nav({ userName }: { userName?: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  // ⌘ on Apple devices, Ctrl elsewhere. useSyncExternalStore is the
  // hydration-safe way to read a client-only value: the server snapshot renders
  // first, then React swaps in the real platform without a mismatch warning.
  const isMac = useSyncExternalStore(
    subscribeNoop,
    () => /mac|iphone|ipad|ipod/i.test(navigator.platform ?? ""),
    () => false,
  );

  // Mobile-only overflow menu (Export/Settings/Sign out). Kept as a plain
  // disclosure rather than a Radix primitive — the repo has no popover/menu
  // dependency yet, and this needs only open/close, not roving-focus menu
  // semantics.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const morePopoverRef = useRef<HTMLDivElement>(null);
  // Guards against a second sign-out firing while one is already in flight
  // (e.g. an impatient double-click) rather than a render-triggering state.
  const signingOutRef = useRef(false);

  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/" || pathname.startsWith("/title")
      : pathname.startsWith(href);

  async function handleSignOut() {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    try {
      await authClient.signOut();
      router.push("/login");
      router.refresh();
    } catch {
      toast.error("Couldn't sign out. Check your connection and try again.");
    } finally {
      signingOutRef.current = false;
    }
  }

  function openCommand() {
    window.dispatchEvent(new Event("celluloid:command"));
  }

  // Close on outside click / Escape; Escape also returns focus to the trigger
  // (outside click leaves focus wherever the user clicked, which is correct).
  useEffect(() => {
    if (!moreOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        morePopoverRef.current?.contains(target) ||
        moreTriggerRef.current?.contains(target)
      ) {
        return;
      }
      setMoreOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  // Any navigation (including via the browser back/forward buttons) should
  // close the popover rather than leaving it open over the new page. This
  // adjusts state during render (the React-endorsed alternative to an
  // effect for resetting state on prop/route change) instead of a
  // setState-in-effect, which would cause an extra cascading render.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setMoreOpen(false);
  }

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4">
          {/* Wordmark text waits for md so the tablet band (640-790px) doesn't
              overflow once link labels appear; a divider keeps the brand and the
              nav reading as two things instead of one run-on row. Extra padding
              below md pads the logo's tap target out to 44px without shifting
              its visible position (the nav row still starts flush left). */}
          <Wordmark size={28} textClassName="hidden md:inline" className="p-2 md:p-0" />
          <span aria-hidden className="hidden h-5 w-px shrink-0 bg-line md:mx-2 md:block" />
          <LayoutGroup>
              {/* Desktop link row — unchanged from before, just newly gated to
                  md+ now that the same four destinations live in the bottom bar
                  on mobile. */}
              <nav className="hidden items-center gap-1 md:flex">
                {LINKS.map((l) => {
                  const Icon = l.icon;
                  const active = isActive(l.href);
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      // Below md the text label is display:none, which removes it
                      // from the accessibility tree — name the link explicitly.
                      aria-label={l.label}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        // Slimmer hit padding on phones: five links plus the brand
                        // and the action cluster must genuinely fit in 375px.
                        "focus-ring relative flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors md:px-3",
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
                      <span className="hidden md:inline">{l.label}</span>
                    </Link>
                  );
                })}
              </nav>
          </LayoutGroup>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={openCommand}
              title={isMac ? "Search (⌘K)" : "Search (Ctrl+K)"}
              aria-label="Search"
              aria-keyshortcuts="Control+K Meta+K"
              // 44px square hit target on mobile (icon stays 15px, centered);
              // reverts to the original content-sized pill at md+.
              className="focus-ring flex h-11 w-11 items-center justify-center gap-1.5 rounded-lg text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground md:h-auto md:w-auto md:justify-start md:px-2 md:py-1.5"
            >
              <Search size={15} />
              <span className="hidden items-center gap-0.5 text-xs text-faint lg:flex">
                {isMac ? <CommandIcon size={11} /> : <span>Ctrl</span>}K
              </span>
            </button>
            {userName && (
              <span className="hidden text-sm text-muted lg:inline">{userName}</span>
            )}
            <Link
              href="/settings"
              title="Settings"
              aria-label="Settings"
              className={cn(
                "focus-ring hidden h-8 w-8 items-center justify-center rounded-lg transition-colors md:flex",
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
              className="focus-ring hidden h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground md:flex"
            >
              <LogOut size={16} />
            </button>

            {/* Mobile-only overflow menu: Export, Settings, Sign out. */}
            <div className="relative md:hidden">
              <button
                ref={moreTriggerRef}
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                aria-controls="nav-more-menu"
                aria-label="More"
                title="More"
                className="focus-ring flex h-11 w-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground"
              >
                <MoreHorizontal size={18} />
              </button>
              <AnimatePresence>
                  {moreOpen && (
                    <motion.div
                      ref={morePopoverRef}
                      id="nav-more-menu"
                      aria-label="More options"
                      initial={{ opacity: 0, y: -6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.97 }}
                      transition={{ duration: 0.15, ease: EASE_OUT }}
                      className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-48 overflow-hidden rounded-xl bg-surface p-1.5 shadow-xl ring-1 ring-line"
                    >
                      <Link
                        href="/export"
                        onClick={() => setMoreOpen(false)}
                        className="focus-ring flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-foreground/90 transition-colors hover:bg-surface-2/60"
                      >
                        <Download size={16} className="text-muted" />
                        Export
                      </Link>
                      <Link
                        href="/settings"
                        onClick={() => setMoreOpen(false)}
                        className="focus-ring flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-foreground/90 transition-colors hover:bg-surface-2/60"
                      >
                        <Settings size={16} className="text-muted" />
                        Settings
                      </Link>
                      <button
                        onClick={() => {
                          setMoreOpen(false);
                          handleSignOut();
                        }}
                        className="focus-ring flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-foreground/90 transition-colors hover:bg-surface-2/60"
                      >
                        <LogOut size={16} className="text-muted" />
                        Sign out
                      </button>
                    </motion.div>
                  )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </header>

      {/* Fixed mobile tab bar — the four primary destinations, always
          reachable without opening the overflow menu. The safe-area inset
          is its own bottom padding (not baked into a fixed height), so on
          notched phones it adds extra clearance instead of squeezing the
          44px+ tap row; layout.tsx pads <main> so content never sits
          behind this bar. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="mx-auto flex max-w-7xl">
          {BOTTOM_LINKS.map((l) => {
            const Icon = l.icon;
            const active = isActive(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "focus-ring flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors",
                  active ? "text-foreground" : "text-muted hover:text-foreground",
                )}
              >
                <Icon size={19} aria-hidden />
                {l.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
