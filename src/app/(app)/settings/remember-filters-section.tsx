"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { setRememberFiltersEnabled } from "@/lib/remembered-state-client";
import { Section } from "./settings-ui";

export function RememberFiltersSection({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);

  function toggle() {
    const next = !enabled;
    setRememberFiltersEnabled(next);
    setEnabled(next);
    toast.success(
      next
        ? "Filter memory is on for this device."
        : "Filter memory is off and saved filters were cleared.",
    );
  }

  return (
    <Section
      icon={SlidersHorizontal}
      title="Remember filters on this device"
      description="Keep each page's viewing preferences between visits."
    >
      {/* rounded-lg like an inset Card: the section card's 14.4px corner sits
          20px out, so an inner 12px corner looked swollen (JK-34). */}
      <div className="flex items-center justify-between gap-4 rounded-lg bg-surface-2/45 p-3 ring-1 ring-line">
        <div>
          <p className="text-sm font-medium">Remember filters</p>
          <p className="mt-0.5 text-xs text-faint">
            Saves library filters and view, recommendation dials, and export scope.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Remember filters on this device"
          onClick={toggle}
          className={cn(
            "focus-ring relative h-6 w-11 shrink-0 rounded-full ring-1 transition-colors",
            enabled ? "bg-brand ring-brand" : "bg-surface ring-line-strong",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
              enabled && "translate-x-5",
            )}
          />
        </button>
      </div>
      <p className="mt-3 text-xs text-faint">
        Stored in this browser only. Search text and recommendation results are never saved.
      </p>
    </Section>
  );
}
