/**
 * The colours a tag may be given.
 *
 * `Tag.color` was written by the restore path and read by nothing, so a tag's
 * colour survived a backup round trip without ever reaching a pixel. Rather
 * than open it to arbitrary hex — which would let a tag pick a colour that
 * clashes with the status badges it sits beside — the owner chooses from the
 * five families the design system already uses (see STATUS_META in format.ts).
 *
 * The class strings are written out in full because Tailwind scans source text:
 * a composed `bg-${family}-500/15` would never make it into the stylesheet.
 */
export const TAG_COLORS = ["slate", "sky", "emerald", "amber", "rose"] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === "string" && (TAG_COLORS as readonly string[]).includes(value);
}

/** Chip classes for an uncoloured tag — the neutral surface every tag starts on. */
export const TAG_COLOR_DEFAULT_CHIP = "bg-surface-2 text-muted ring-line";

/** Swatch classes for the "no colour" choice in the picker. */
export const TAG_COLOR_DEFAULT_SWATCH = "bg-surface-2 ring-line";

export const TAG_COLOR_META: Record<
  TagColor,
  { label: string; chip: string; swatch: string }
> = {
  slate: {
    label: "Slate",
    chip: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
    swatch: "bg-slate-400 ring-slate-500/30",
  },
  sky: {
    label: "Sky",
    chip: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
    swatch: "bg-sky-400 ring-sky-500/30",
  },
  emerald: {
    label: "Emerald",
    chip: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    swatch: "bg-emerald-400 ring-emerald-500/30",
  },
  amber: {
    label: "Amber",
    chip: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    swatch: "bg-amber-400 ring-amber-500/30",
  },
  rose: {
    label: "Rose",
    chip: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
    swatch: "bg-rose-400 ring-rose-500/30",
  },
};

/**
 * Chip classes for a stored colour. Anything unrecognized (a colour from an
 * older palette, or a hand-edited row) falls back to the neutral chip instead
 * of rendering an unstyled element.
 */
export function tagChipClass(color: string | null | undefined): string {
  return isTagColor(color) ? TAG_COLOR_META[color].chip : TAG_COLOR_DEFAULT_CHIP;
}
