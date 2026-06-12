import type { TmdbSearchItem } from "@/lib/tmdb";

/** Normalize a title for fuzzy comparison (lowercase, strip accents/punctuation). */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining diacritics (the explicit escape survives any re-encode
    // of this file; raw combining chars in a regex literal are fragile).
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Release/air year of a TMDB result, or null. */
export function yearOf(item: TmdbSearchItem): number | null {
  const d = item.release_date ?? item.first_air_date;
  const y = d ? Number(d.slice(0, 4)) : NaN;
  return Number.isFinite(y) ? y : null;
}

/** Stable dedup key for a title across matched and unmatched entries. */
export function nameYearKey(
  mediaType: "movie" | "tv",
  name: string,
  year: number | null | undefined,
): string {
  return `${mediaType}:${norm(name)}:${year ?? "?"}`;
}

/**
 * Pick the best TMDB result for a (title, year), or null when nothing is a
 * credible match. Name match scores highest; the year corroborates it; TMDB's
 * own ranking breaks ties. Returning null when no candidate clears the bar stops
 * a wrong title from hijacking a poster/year just because the year lined up.
 *
 * Transliteration carve-out: a foreign/transliterated title (e.g. a Malayalam
 * film) often won't substring-match TMDB's romanization, so we also accept
 * TMDB's own top-ranked hit when the year matches within one year. That is
 * strong corroboration without letting a year-only coincidence deeper in the
 * list slip through.
 */
export function pickBest(
  results: TmdbSearchItem[],
  title: string,
  year: number | null,
): TmdbSearchItem | null {
  if (results.length === 0) return null;
  const target = norm(title);

  const scored = results.map((r, i) => {
    const rn = norm(r.title ?? r.name ?? "");
    const ry = yearOf(r);
    // A title in a non-Latin script normalizes to "", and any string includes
    // "" - without the length guards such a query would "partial match" every
    // result and bypass the carve-out below. Empty-vs-empty is no signal either.
    const nameMatch: "exact" | "partial" | "none" =
      target.length > 0 && rn === target
        ? "exact"
        : target.length > 0 && rn.length > 0 && (rn.includes(target) || target.includes(rn))
          ? "partial"
          : "none";
    const yearDiff = year != null && ry != null ? Math.abs(ry - year) : null;
    let s = 0;
    if (nameMatch === "exact") s += 100;
    else if (nameMatch === "partial") s += 45;
    if (yearDiff != null) {
      s += yearDiff === 0 ? 30 : yearDiff === 1 ? 12 : Math.max(0, 6 - yearDiff);
    }
    s += (r.vote_average ?? 0) * 0.1;
    s -= i * 0.75; // gently prefer TMDB's own relevance ranking
    return { r, i, s, nameMatch, yearDiff };
  });

  let best = scored[0];
  for (const c of scored) if (c.s > best.s) best = c;

  // Keep the wrong-poster protection (a real name overlap is required), but let
  // a transliterated title resolve via TMDB's top hit + a corroborating year.
  const nameOk = best.nameMatch !== "none";
  const transliterationOk =
    best.i === 0 && best.yearDiff != null && best.yearDiff <= 1;
  return nameOk || transliterationOk ? best.r : null;
}
