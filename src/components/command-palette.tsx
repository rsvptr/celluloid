"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Title as DialogTitle } from "@radix-ui/react-dialog";
import { toast } from "sonner";
import {
  ArrowLeft,
  BarChart3,
  Bookmark,
  CalendarClock,
  CalendarPlus,
  Check,
  Download,
  Film,
  Plus,
  Search,
  Settings,
  Sparkles,
  Tv,
} from "lucide-react";
import type { TitleIndexEntry } from "@/lib/data";
import type { WatchStatus } from "@/generated/prisma/client";
import { logWatch, undoWatchedTransition, updateTitle } from "@/lib/actions";

const NAV = [
  { href: "/", label: "Library", icon: Film },
  { href: "/add", label: "Add a title", icon: Plus },
  // "Airing soon" rather than the nav's "Airing": the short label there exists
  // only because five tab-bar targets share a 320px row, and this list has room
  // for the page's own name.
  { href: "/upcoming", label: "Airing soon", icon: CalendarClock },
  { href: "/recommend", label: "Recommendations", icon: Sparkles },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/export", label: "Export", icon: Download },
  { href: "/settings", label: "Settings", icon: Settings },
];

/**
 * Things the palette can do TO a title, rather than navigate to.
 *
 * The palette already held the whole title index but could only ever push a
 * route, so the quickest way to mark last night's film watched was still: open
 * the palette, open the title, wait for the page, change the status. Each entry
 * here is a two-step flow — pick the verb, then pick the title — which keeps the
 * root list short and unambiguous instead of multiplying every title by three.
 */
type ActionKind = "watched" | "watchlist" | "log";

const ACTIONS: {
  kind: ActionKind;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  /** Heading shown on the title-picking step. */
  prompt: string;
  placeholder: string;
}[] = [
  {
    kind: "watched",
    label: "Mark a title watched",
    icon: Check,
    prompt: "Mark watched",
    placeholder: "Which title did you finish?",
  },
  {
    kind: "log",
    label: "Log a watch (today)",
    icon: CalendarPlus,
    prompt: "Log a watch today",
    placeholder: "Which title did you watch?",
  },
  {
    kind: "watchlist",
    label: "Add a title to your watchlist",
    icon: Bookmark,
    prompt: "Move to watchlist",
    placeholder: "Which title?",
  },
];

const groupClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint";

const itemClass =
  "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground/90 data-[selected=true]:bg-surface-2 data-[selected=true]:text-foreground sm:min-h-0";

/** Today as yyyy-mm-dd in the viewer's local time, matching the log-watch dialog. */
function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function CommandPalette({ titles: seed = [] }: { titles?: TitleIndexEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [titles, setTitles] = useState<TitleIndexEntry[]>(seed);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [search, setSearch] = useState("");
  // null = the root list. Non-null = picking a title for that action.
  const [action, setAction] = useState<ActionKind | null>(null);
  const [running, setRunning] = useState(false);
  // Remember what was focused so we can restore it when the palette closes.
  const opener = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setAction(null);
    setSearch("");
    // Controlled dialog has no Radix trigger, so restore focus ourselves after
    // cmdk has removed the dialog from the tree.
    requestAnimationFrame(() => opener.current?.focus());
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) {
          close();
        } else {
          opener.current = document.activeElement as HTMLElement | null;
          setOpen(true);
        }
      }
    }
    function onOpen() {
      opener.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("celluloid:command", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("celluloid:command", onOpen);
    };
  }, [close, open]);

  // Fetch the index each time the palette opens: lazily on the first open (the
  // layout no longer ships it with every page) and refreshed on later opens so
  // newly added/removed titles appear without a full reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/titles")
      .then((r) => {
        if (!r.ok) throw new Error("title-index-request-failed");
        return r.json();
      })
      .then((d) => {
        if (!cancelled && d?.titles) {
          setTitles(d.titles as TitleIndexEntry[]);
          setLoaded(true);
          setLoadError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't load your titles.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, retryKey]);

  function go(href: string) {
    close();
    router.push(href);
  }

  /** Back out of an action to the root list, clearing the filter with it. */
  function backToRoot() {
    setAction(null);
    setSearch("");
  }

  function startAction(kind: ActionKind) {
    setAction(kind);
    setSearch("");
  }

  async function runAction(kind: ActionKind, title: TitleIndexEntry) {
    if (running) return;
    setRunning(true);
    try {
      if (kind === "log") {
        const res = await logWatch(title.id, { occurredAt: todayLocalDate() });
        if (res.error) {
          toast.error(res.error);
          return;
        }
        const n = res.watchCount ?? 1;
        toast.success(`Logged ${title.name}. Watched ${n} ${n === 1 ? "time" : "times"}.`);
      } else {
        const status: WatchStatus = kind === "watched" ? "WATCHED" : "WATCHLIST";
        const res = await updateTitle(title.id, { status });
        if (res.error) {
          toast.error(res.error);
          return;
        }
        const message =
          kind === "watched"
            ? `Marked ${title.name} watched`
            : `Moved ${title.name} to your watchlist`;
        const undo = res.undo;
        toast.success(
          message,
          undo
            ? {
                action: {
                  label: "Undo",
                  onClick: () => {
                    void undoWatchedTransition(
                      undo.titleId,
                      undo.occurredAt,
                      undo.restoreWatchedAt,
                    )
                      .then((undoResult) => {
                        if (undoResult.error) toast.error(undoResult.error);
                        else toast.success(`Undid watched change for ${title.name}`);
                        router.refresh();
                      })
                      .catch(() => {
                        toast.error("Couldn't undo that watched change. Try again.");
                        router.refresh();
                      });
                  },
                },
              }
            : undefined,
        );
      }
      close();
      router.refresh();
    } catch {
      toast.error("Couldn't update that title. Try again.");
    } finally {
      setRunning(false);
    }
  }

  const activeAction = ACTIONS.find((a) => a.kind === action) ?? null;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setOpen(true);
        else close();
      }}
      onKeyDown={(e) => {
        // Backspace on an empty query steps back out of an action — the same
        // gesture that clears the last character, so the flow stays keyboard-only.
        if (e.key === "Backspace" && !search && action) {
          e.preventDefault();
          backToRoot();
        }
      }}
      label="Command menu"
      overlayClassName="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[12dvh] z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl bg-surface ring-1 ring-line shadow-2xl"
    >
      <DialogTitle className="sr-only">Command menu</DialogTitle>
      <div className="flex items-center gap-2 border-b border-line px-4">
        {activeAction ? (
          <button
            type="button"
            onClick={backToRoot}
            aria-label="Back to all commands"
            className="focus-ring -ml-1 flex shrink-0 items-center gap-1.5 rounded-md py-1 pr-1.5 pl-1 text-xs font-medium text-brand"
          >
            <ArrowLeft size={14} aria-hidden />
            {activeAction.prompt}
          </button>
        ) : (
          <Search size={16} className="text-faint" />
        )}
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder={
            activeAction ? activeAction.placeholder : "Search titles or jump to a page…"
          }
          className="h-12 w-full bg-transparent text-base text-foreground outline-none placeholder:text-faint sm:text-sm"
        />
      </div>
      <Command.List className="max-h-[60dvh] overflow-y-auto overscroll-contain p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
          {loadError ? (
            <div className="flex flex-col items-center gap-2">
              <p>{loadError}</p>
              <button
                type="button"
                onClick={() => {
                  setLoadError(null);
                  setRetryKey((v) => v + 1);
                }}
                className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-brand ring-1 ring-line hover:bg-surface-2"
              >
                Retry
              </button>
            </div>
          ) : loaded || titles.length > 0 ? (
            "No matches."
          ) : (
            "Loading your titles…"
          )}
        </Command.Empty>

        {activeAction ? (
          <Command.Group heading={activeAction.prompt} className={groupClass}>
            {titles.map((t) => {
              const Icon = t.mediaType === "TV" ? Tv : Film;
              return (
                <Command.Item
                  key={t.id}
                  value={`${t.name} ${t.year ?? ""}`}
                  disabled={running}
                  onSelect={() => runAction(activeAction.kind, t)}
                  className={itemClass}
                >
                  <Icon size={15} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  {t.year ? (
                    <span className="shrink-0 text-xs text-faint">{t.year}</span>
                  ) : null}
                </Command.Item>
              );
            })}
          </Command.Group>
        ) : (
          <>
            <Command.Group heading="Do" className={groupClass}>
              {ACTIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <Command.Item
                    key={a.kind}
                    value={`do ${a.label}`}
                    onSelect={() => startAction(a.kind)}
                    className={itemClass}
                  >
                    <Icon size={15} className="text-brand" />
                    <span className="min-w-0 flex-1 truncate">{a.label}</span>
                    <span className="shrink-0 text-xs text-faint">Pick a title</span>
                  </Command.Item>
                );
              })}
            </Command.Group>

            <Command.Group heading="Go to" className={groupClass}>
              {NAV.map((n) => {
                const Icon = n.icon;
                return (
                  <Command.Item
                    key={n.href}
                    value={`go ${n.label}`}
                    onSelect={() => go(n.href)}
                    className={itemClass}
                  >
                    <Icon size={15} className="text-muted" />
                    {n.label}
                  </Command.Item>
                );
              })}
            </Command.Group>

            {titles.length > 0 && (
              <Command.Group heading="Open a title" className={groupClass}>
                {titles.map((t) => {
                  const Icon = t.mediaType === "TV" ? Tv : Film;
                  return (
                    <Command.Item
                      key={t.id}
                      value={`${t.name} ${t.year ?? ""}`}
                      onSelect={() => go(`/title/${t.id}`)}
                      className={itemClass}
                    >
                      <Icon size={15} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      {t.year ? (
                        <span className="shrink-0 text-xs text-faint">{t.year}</span>
                      ) : null}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}
          </>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
