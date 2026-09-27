import { defaultFilter } from "cmdk";

/**
 * Most titles the command palette renders at once (VE-14). cmdk mounts an item
 * for every title it is given, even the ones its filter hides, so the palette
 * gives it only the best matches. Search still reaches the whole index.
 */
export const PALETTE_TITLE_LIMIT = 50;

type IndexedTitle = { name: string; year: number | null };

/** What cmdk matches a title on; also the palette item's `value`. */
export function paletteTitleValue(title: IndexedTitle): string {
  return `${title.name} ${title.year ?? ""}`;
}

/**
 * The titles to render for `search`: index order with no search, otherwise the
 * matches cmdk itself would keep, best first. Scoring with cmdk's own filter,
 * on the trimmed value it scores, keeps the match set exactly what it was
 * before the cap, and means the cap only drops the weakest matches.
 */
export function paletteTitles<T extends IndexedTitle>(titles: T[], search: string): T[] {
  if (!search) return titles.slice(0, PALETTE_TITLE_LIMIT);
  return titles
    .map((title) => ({ title, score: defaultFilter(paletteTitleValue(title).trim(), search) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, PALETTE_TITLE_LIMIT)
    .map((entry) => entry.title);
}
