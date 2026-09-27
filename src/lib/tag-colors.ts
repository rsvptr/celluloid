/**
 * The colours a tag may be given.
 *
 * `Tag.color` was written by the restore path and read by nothing, so a tag's
 * colour survived a backup round trip without ever reaching a pixel. Rather
 * than open it to arbitrary hex, the owner chooses from a fixed palette.
 *
 * The palette's hues belong to tags alone (JK-17): each is at least 22° from a
 * status hue (sky, amber, emerald, slate and rose; see the color roles in
 * globals.css), so a tag chip never reads as a status badge beside it. Text on
 * each chip measures 7.5:1 or more on surface and surface-2.
 *
 * The class strings are written out in full because Tailwind scans source text:
 * a composed `bg-${family}-500/15` would never make it into the stylesheet.
 */
export const TAG_COLORS = ["orange", "lime", "violet", "fuchsia", "pink"] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === "string" && (TAG_COLORS as readonly string[]).includes(value);
}

/**
 * The first palette reused the status families. Rows (and backups) that still
 * hold one of those names render as the nearest tag hue; slate, the grey, as
 * no colour. New writes only accept TAG_COLORS.
 */
const LEGACY_TAG_COLORS: Record<string, TagColor | null> = {
  amber: "orange",
  emerald: "lime",
  sky: "violet",
  rose: "pink",
  slate: null,
};

/** The palette colour a stored value renders as, or null for the neutral chip. */
export function tagColorKey(color: string | null | undefined): TagColor | null {
  if (isTagColor(color)) return color;
  return color && Object.hasOwn(LEGACY_TAG_COLORS, color) ? LEGACY_TAG_COLORS[color] : null;
}

/** Chip classes for an uncoloured tag — the neutral surface every tag starts on. */
export const TAG_COLOR_DEFAULT_CHIP = "bg-surface-2 text-muted ring-line";

/** Swatch classes for the "no colour" choice in the picker. */
export const TAG_COLOR_DEFAULT_SWATCH = "bg-surface-2 ring-line";

export const TAG_COLOR_META: Record<
  TagColor,
  { label: string; chip: string; swatch: string }
> = {
  orange: {
    label: "Orange",
    chip: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
    swatch: "bg-orange-400 ring-orange-500/30",
  },
  lime: {
    label: "Lime",
    chip: "bg-lime-500/15 text-lime-300 ring-lime-500/30",
    swatch: "bg-lime-400 ring-lime-500/30",
  },
  violet: {
    label: "Violet",
    chip: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
    swatch: "bg-violet-400 ring-violet-500/30",
  },
  fuchsia: {
    label: "Fuchsia",
    chip: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
    swatch: "bg-fuchsia-400 ring-fuchsia-500/30",
  },
  pink: {
    label: "Pink",
    chip: "bg-pink-500/15 text-pink-300 ring-pink-500/30",
    swatch: "bg-pink-400 ring-pink-500/30",
  },
};

/**
 * Chip classes for a stored colour. Anything unrecognized (a hand-edited row)
 * falls back to the neutral chip instead of rendering an unstyled element.
 */
export function tagChipClass(color: string | null | undefined): string {
  const key = tagColorKey(color);
  return key ? TAG_COLOR_META[key].chip : TAG_COLOR_DEFAULT_CHIP;
}
