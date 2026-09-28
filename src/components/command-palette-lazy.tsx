"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { whenIdle } from "@/lib/when-idle";

const CommandPalette = dynamic(
  () => import("@/components/command-palette").then((m) => m.CommandPalette),
  { ssr: false },
);

/**
 * Keeps the cmdk/Radix palette chunk out of every page's first load: the
 * palette used to ride the critical bundle of all authenticated routes even
 * when never opened (AUD-NEXT-03). It now mounts once the page goes idle
 * (with a timeout so throttled tabs still get it), which in practice is well
 * before a person can reach for Ctrl/Cmd+K — so the trigger contract and the
 * palette's own focus handling are unchanged. Either intent signal also arms
 * it immediately; a press that lands during the chunk fetch is honored on the
 * next press, the same as any not-yet-hydrated shortcut.
 */
export function LazyCommandPalette() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    const arm = () => setReady(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") arm();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("celluloid:command", arm);
    const cancelIdle = whenIdle(arm);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("celluloid:command", arm);
      cancelIdle();
    };
  }, [ready]);
  return ready ? <CommandPalette /> : null;
}
