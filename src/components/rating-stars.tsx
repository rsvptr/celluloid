"use client";

import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { Star } from "lucide-react";

// The 1-10 scale is always shown as five stars, so each star is worth two
// points and a half-star is worth one (fractional fill covers the 0.5 steps).
const STARS = 5;

/**
 * 0.5-step rating on a 1-10 scale, shown as five large stars with proportional
 * amber fill. One control — not twenty per-half hit zones: pointer-down + move
 * scrubs the value continuously across the row (snapped to 0.5 and mapped onto
 * 1..max), pointer-up commits, and a plain tap commits the tapped position. The
 * row is a focusable `role="slider"` with the usual arrow/Home/End keyboard
 * control; an explicit Clear button removes the rating.
 */
export function RatingStars({
  value,
  onChange,
  max = 10,
  size = 40,
  disabled,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  max?: number;
  size?: number;
  disabled?: boolean;
}) {
  // `preview` reflects an in-progress hover/scrub and never commits until
  // pointer-up (keyboard actions call onChange directly).
  const [preview, setPreview] = useState<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const display = preview ?? value ?? 0;
  const pointsPerStar = max / STARS;

  // Map a pointer x-position across the row to a 0.5-step value in [0.5, max].
  function valueFromClientX(clientX: number): number {
    const el = rowRef.current;
    if (!el) return value ?? 0.5;
    const rect = el.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const clamped = Math.max(0, Math.min(1, ratio));
    const snapped = Math.round(clamped * max * 2) / 2;
    return Math.min(max, Math.max(0.5, snapped));
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (disabled || e.button > 0) return; // primary button / touch / pen only
    draggingRef.current = true;
    // Capture so the scrub keeps tracking even if the pointer leaves the row.
    rowRef.current?.setPointerCapture(e.pointerId);
    setPreview(valueFromClientX(e.clientX));
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    // Scrub while pressed; also preview under a hovering mouse (touch has none).
    if (draggingRef.current || e.pointerType === "mouse") {
      setPreview(valueFromClientX(e.clientX));
    }
  }

  function releaseCapture(e: PointerEvent<HTMLDivElement>) {
    if (rowRef.current?.hasPointerCapture(e.pointerId)) {
      rowRef.current.releasePointerCapture(e.pointerId);
    }
    draggingRef.current = false;
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (disabled || !draggingRef.current) return;
    const next = valueFromClientX(e.clientX);
    releaseCapture(e);
    setPreview(null);
    onChange(next); // tap and scrub-release both commit the position value
  }

  function onPointerCancel(e: PointerEvent<HTMLDivElement>) {
    // Interrupted gesture: drop the preview without committing.
    releaseCapture(e);
    setPreview(null);
  }

  function onPointerLeave() {
    if (!draggingRef.current) setPreview(null); // end a mouse hover preview
  }

  // Keyboard control (unchanged semantics): arrows nudge by half/whole steps,
  // Home/End jump to the ends, 0/Delete/Backspace clears.
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div
        ref={rowRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Rating"
        aria-disabled={disabled || undefined}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value ?? 0}
        aria-valuetext={value ? `${value} out of ${max}` : "Not rated"}
        // touch-none stops the browser from scroll-fighting the scrub gesture.
        className="focus-ring flex touch-none select-none items-center gap-1 rounded"
        style={{ cursor: disabled ? "default" : "pointer" }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
      >
        {Array.from({ length: STARS }, (_, i) => i).map((i) => {
          const pct = Math.max(
            0,
            Math.min(100, ((display - i * pointsPerStar) / pointsPerStar) * 100),
          );
          return (
            // Outer span is the touch target: >=44px below sm, collapsing back
            // to the glyph's own size at sm+ (min-h/min-w-0 cancels the floor).
            // The inner span keeps the glyph's exact size/positioning context
            // untouched, so the visible star never changes size.
            <span
              key={i}
              className="relative inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center sm:min-h-0 sm:min-w-0"
            >
              <span className="relative inline-block" style={{ width: size, height: size }}>
                <Star size={size} className="text-faint" />
                {pct > 0 && (
                  <span
                    className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden"
                    style={{ width: `${pct}%` }}
                  >
                    <Star size={size} className="fill-amber-300 text-amber-300" />
                  </span>
                )}
              </span>
            </span>
          );
        })}
      </div>

      <span className="w-16 shrink-0 text-sm tabular-nums text-muted">
        {display ? `${display}/${max}` : "Not rated"}
      </span>

      {!disabled && value != null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          // Padding + a matching negative margin grows the hit area to >=44px
          // below sm without shifting layout or changing the visible size;
          // both cancel out at sm+ so desktop is pixel-identical.
          className="focus-ring -mx-2 -my-3.5 rounded px-2 py-3.5 text-xs font-medium text-faint hover:text-muted sm:m-0 sm:p-0"
        >
          Clear
        </button>
      )}
    </div>
  );
}
