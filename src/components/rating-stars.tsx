"use client";

import { type KeyboardEvent, useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 0.5-step star rating on a 1-10 scale. Each star has two hit zones (left = the
 * half value, right = the whole value); the fill is an amber star clipped to the
 * current value. Tapping the active value again clears the rating.
 */
export function RatingStars({
  value,
  onChange,
  max = 10,
  size = 22,
  disabled,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  max?: number;
  size?: number;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const display = hover ?? value ?? 0;

  // Keyboard control for the rating-entry workflow: arrows nudge by half/whole
  // steps, Home/End jump to the ends, 0/Delete clears. Events bubble up from the
  // focused star button, so one handler on the wrapper covers all of them.
  function onKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    const base = value ?? 0;
    const set = (v: number) => onChange(Math.min(max, Math.max(0.5, Math.round(v * 2) / 2)));
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        set(base + (e.key === "ArrowUp" ? 1 : 0.5));
        break;
      case "ArrowLeft":
      case "ArrowDown": {
        e.preventDefault();
        const next = base - (e.key === "ArrowDown" ? 1 : 0.5);
        if (next < 0.5) onChange(null);
        else set(next);
        break;
      }
      case "Home":
        e.preventDefault();
        onChange(0.5);
        break;
      case "End":
        e.preventDefault();
        onChange(max);
        break;
      case "0":
      case "Delete":
      case "Backspace":
        e.preventDefault();
        onChange(null);
        break;
    }
  }

  return (
    <div
      className="flex items-center gap-2"
      onMouseLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-0.5">
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
          const pct = display >= n ? 100 : display >= n - 0.5 ? 50 : 0;
          return (
            <span
              key={n}
              className="relative inline-block shrink-0"
              style={{ width: size, height: size }}
            >
              <Star size={size} className="text-faint" />
              {pct > 0 && (
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden"
                  style={{ width: `${pct}%` }}
                >
                  <Star size={size} className="fill-amber-300 text-amber-300" />
                </span>
              )}
              {!disabled && (
                <>
                  <button
                    type="button"
                    aria-label={`Rate ${n - 0.5} out of ${max}`}
                    className="focus-ring absolute left-0 z-10 w-1/2 rounded"
                    style={{ top: -8, bottom: -8 }}
                    onMouseEnter={() => setHover(n - 0.5)}
                    onClick={() => onChange(value === n - 0.5 ? null : n - 0.5)}
                  />
                  <button
                    type="button"
                    aria-label={`Rate ${n} out of ${max}`}
                    className="focus-ring absolute right-0 z-10 w-1/2 rounded"
                    style={{ top: -8, bottom: -8 }}
                    onMouseEnter={() => setHover(n)}
                    onClick={() => onChange(value === n ? null : n)}
                  />
                </>
              )}
            </span>
          );
        })}
      </div>
      <span className="w-16 shrink-0 text-sm tabular-nums text-muted">
        {display ? `${display}/10` : "Not rated"}
      </span>
    </div>
  );
}
