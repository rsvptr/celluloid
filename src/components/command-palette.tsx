"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Title as DialogTitle } from "@radix-ui/react-dialog";
import {
  BarChart3,
  Download,
  Film,
  Plus,
  Search,
  Settings,
  Sparkles,
  Tv,
} from "lucide-react";
import type { TitleIndexEntry } from "@/lib/data";

const NAV = [
  { href: "/", label: "Library", icon: Film },
  { href: "/add", label: "Add a title", icon: Plus },
  { href: "/recommend", label: "AI recommendations", icon: Sparkles },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/export", label: "Export", icon: Download },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function CommandPalette({ titles: seed }: { titles: TitleIndexEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [titles, setTitles] = useState<TitleIndexEntry[]>(seed);
  // Remember what was focused so we can restore it when the palette closes.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => {
          if (!v) opener.current = document.activeElement as HTMLElement | null;
          return !v;
        });
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
  }, []);

  // Refresh the index each time the palette opens so newly added/removed titles
  // appear without a full reload (the server layout list can be stale).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/titles")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.titles) setTitles(d.titles as TitleIndexEntry[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        // Controlled dialog has no Radix trigger, so restore focus ourselves.
        if (!o) requestAnimationFrame(() => opener.current?.focus());
      }}
      label="Command menu"
      overlayClassName="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl bg-surface ring-1 ring-line shadow-2xl"
    >
      <DialogTitle className="sr-only">Command menu</DialogTitle>
      <div className="flex items-center gap-2 border-b border-line px-4">
        <Search size={16} className="text-faint" />
        <Command.Input
          autoFocus
          placeholder="Search titles or jump to a page…"
          className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
        />
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
          No matches.
        </Command.Empty>

        <Command.Group
          heading="Go to"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"
        >
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <Command.Item
                key={n.href}
                value={`go ${n.label}`}
                onSelect={() => go(n.href)}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground/90 data-[selected=true]:bg-surface-2 data-[selected=true]:text-foreground"
              >
                <Icon size={15} className="text-muted" />
                {n.label}
              </Command.Item>
            );
          })}
        </Command.Group>

        {titles.length > 0 && (
          <Command.Group
            heading="Titles"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"
          >
            {titles.map((t) => {
              const Icon = t.mediaType === "TV" ? Tv : Film;
              return (
                <Command.Item
                  key={t.id}
                  value={`${t.name} ${t.year ?? ""}`}
                  onSelect={() => go(`/title/${t.id}`)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground/90 data-[selected=true]:bg-surface-2 data-[selected=true]:text-foreground"
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
      </Command.List>
    </Command.Dialog>
  );
}
