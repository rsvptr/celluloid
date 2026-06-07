// Pure, client-safe export formatters. No server imports.

export type ExportStatus =
  | "WATCHLIST"
  | "WATCHING"
  | "WATCHED"
  | "ON_HOLD"
  | "DROPPED";

export interface ExportRow {
  id: string;
  name: string;
  mediaType: "movie" | "tv";
  year: number | null;
  releaseDate: string | null;
  languageCode: string | null;
  language: string;
  statusKey: ExportStatus;
  status: string;
  myRating: number | null;
  tmdbRating: number | null;
  genres: string[];
  totalEpisodes: number | null;
  watchedEpisodes: number;
  favorite: boolean;
  notes: string | null;
  tags: string[];
  watchedAt: string | null;
  createdAt: string;
}

export interface ExportScope {
  type: "all" | "movie" | "tv";
  status: "all" | ExportStatus;
  favoritesOnly: boolean;
  tag: string | null;
}

export const DEFAULT_SCOPE: ExportScope = {
  type: "all",
  status: "all",
  favoritesOnly: false,
  tag: null,
};

export function filterRows(rows: ExportRow[], scope: ExportScope): ExportRow[] {
  return rows.filter((r) => {
    if (scope.type !== "all" && r.mediaType !== scope.type) return false;
    if (scope.status !== "all" && r.statusKey !== scope.status) return false;
    if (scope.favoritesOnly && !r.favorite) return false;
    if (scope.tag && !r.tags.includes(scope.tag)) return false;
    return true;
  });
}

function progress(r: ExportRow): string {
  if (r.mediaType === "tv" && r.totalEpisodes) {
    return `${r.watchedEpisodes}/${r.totalEpisodes} eps`;
  }
  return "";
}

function compactLine(r: ExportRow, withRating = true): string {
  const title = r.year ? `${r.name} (${r.year})` : r.name;
  const parts = [r.favorite ? `★ ${title}` : title];
  if (withRating && r.myRating != null) parts.push(`${r.myRating}/10`);
  const p = progress(r);
  if (p) parts.push(p);
  if (r.genres.length) parts.push(r.genres.slice(0, 3).join("/"));
  if (r.languageCode && r.languageCode !== "en") parts.push(r.language);
  if (r.tags.length) parts.push(r.tags.slice(0, 3).map((t) => `#${t}`).join(" "));
  return parts.join(" · ");
}

/** A title's notes, collapsed to one short line for the AI prompt (or null). */
function noteHint(notes: string | null): string | null {
  if (!notes) return null;
  const flat = notes.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- Plain text ------------------------------------------------------------

export function toText(rows: ExportRow[]): string {
  const movies = rows.filter((r) => r.mediaType === "movie");
  const tv = rows.filter((r) => r.mediaType === "tv");
  const lines: string[] = [
    "My Celluloid Library",
    `Generated ${todayISO()} · ${rows.length} titles`,
    "",
  ];

  const section = (heading: string, list: ExportRow[]) => {
    if (!list.length) return;
    lines.push(`${heading} (${list.length})`);
    for (const r of list) {
      const bits = [r.status];
      if (r.myRating != null) bits.push(`★${r.myRating}/10`);
      const p = progress(r);
      if (p) bits.push(p);
      if (r.languageCode) bits.push(r.language);
      lines.push(`- ${r.name}${r.year ? ` (${r.year})` : ""} · ${bits.join(" · ")}`);
    }
    lines.push("");
  };

  section("MOVIES", movies);
  section("TV SHOWS", tv);
  return lines.join("\n").trim() + "\n";
}

// --- Markdown --------------------------------------------------------------

export function toMarkdown(rows: ExportRow[]): string {
  const lines: string[] = [
    "# My Celluloid Library",
    "",
    `_Generated ${todayISO()} · ${rows.length} titles_`,
    "",
    "| Title | Type | Year | Status | My rating | Progress | Language |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${escapeMd(r.name)} | ${r.mediaType === "tv" ? "TV" : "Movie"} | ${r.year ?? ""} | ${r.status} | ${r.myRating != null ? `${r.myRating}/10` : ""} | ${progress(r)} | ${r.languageCode ? r.language : ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|");
}

// --- JSON ------------------------------------------------------------------

export function toJson(rows: ExportRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      name: r.name,
      type: r.mediaType,
      year: r.year,
      releaseDate: r.releaseDate,
      language: r.language,
      status: r.status,
      myRating: r.myRating,
      tmdbRating: r.tmdbRating,
      genres: r.genres,
      ...(r.mediaType === "tv"
        ? { watchedEpisodes: r.watchedEpisodes, totalEpisodes: r.totalEpisodes }
        : {}),
      favorite: r.favorite,
      tags: r.tags,
      notes: r.notes ?? undefined,
    })),
    null,
    2,
  );
}

// --- AI recommendation prompt (the hero format) ----------------------------

/**
 * The grouped taste dump (no trailing task instruction), reused by both the
 * in-app Recommend feature and the "copy as AI prompt" export.
 *
 * `opts.watchlist` overrides the watchlist exclusion block. The recommend path
 * scopes `rows` to a chosen basis (recent / picked titles) but still passes the
 * full watchlist so "do NOT recommend what I've already planned" always holds.
 */
export function tasteSummary(
  rows: ExportRow[],
  opts?: { watchlist?: ExportRow[]; abandoned?: ExportRow[] },
): string {
  // Bound each block so a large library yields a focused, signal-dense prompt
  // (the extremes of the rating scale carry the most taste signal; the lukewarm
  // middle and long secondary lists mostly dilute it).
  const rated = rows
    .filter(
      (r) =>
        r.myRating != null &&
        r.statusKey !== "WATCHLIST" &&
        r.statusKey !== "DROPPED",
    )
    .sort((a, b) => (b.myRating ?? 0) - (a.myRating ?? 0));
  // Split the rated list so low scores read as an explicit negative signal, not
  // just "more data" the model has to infer the polarity of.
  const ratedSeen = rated.filter((r) => (r.myRating ?? 0) > 4).slice(0, 50);
  const ratedLow = rated
    .filter((r) => (r.myRating ?? 0) <= 4)
    .sort((a, b) => (a.myRating ?? 0) - (b.myRating ?? 0))
    .slice(0, 20);
  const watchedUnrated = rows
    .filter((r) => r.myRating == null && r.statusKey === "WATCHED")
    .slice(0, 30);
  const abandoned = (
    opts?.abandoned ?? rows.filter((r) => r.statusKey === "DROPPED")
  ).slice(0, 30);
  const watching = rows.filter((r) => r.statusKey === "WATCHING").slice(0, 25);
  const watchlist = (
    opts?.watchlist ?? rows.filter((r) => r.statusKey === "WATCHLIST")
  ).slice(0, 40);

  // Re-surface the most recent real watches (in-app watch dates only, so this
  // stays silent for the imported backlog that has none) to weight current mood.
  const recent = rows
    .filter((r) => r.watchedAt && r.statusKey !== "DROPPED" && r.statusKey !== "WATCHLIST")
    .sort((a, b) => (b.watchedAt ?? "").localeCompare(a.watchedAt ?? ""))
    .slice(0, 15);

  const out: string[] = [
    "The following is my personal film & TV watch history, exported from my tracker (Celluloid). Use it to understand my taste in detail.",
    "",
  ];

  // A computed language/regional lean from my strongest-signal titles (rated or
  // favorited), so the model biases toward my actual taste, not English defaults.
  const langCount = new Map<string, number>();
  for (const r of rows) {
    if ((r.myRating != null || r.favorite) && r.languageCode) {
      langCount.set(r.language, (langCount.get(r.language) ?? 0) + 1);
    }
  }
  const topLangs = [...langCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([l]) => l);
  if (topLangs.length) {
    out.push(`I mostly watch in these languages: ${topLangs.join(", ")}.`, "");
  }

  const block = (heading: string, list: ExportRow[], withRating = true) => {
    if (!list.length) return;
    out.push(heading);
    for (const r of list) {
      out.push(`- ${compactLine(r, withRating)}`);
      const note = noteHint(r.notes);
      if (note) out.push(`  note: ${note}`);
    }
    out.push("");
  };

  block("★ WATCHED & RATED (my strongest taste signal, higher = better):", ratedSeen);
  block(
    "RATED LOW (I did not enjoy these, so avoid recommending things like them):",
    ratedLow,
  );
  block("WATCHED (not yet rated):", watchedUnrated, false);
  if (recent.length) {
    block("RECENTLY WATCHED (reflects my current mood, weight these):", recent);
  }
  block("CURRENTLY WATCHING:", watching, false);
  block("ABANDONED / didn't finish (do NOT recommend things like these):", abandoned);
  block(
    "ON MY WATCHLIST (already planned, so do NOT recommend these, and don't repeat anything above):",
    watchlist,
    false,
  );

  return out.join("\n").trimEnd();
}

export function toAiPrompt(
  rows: ExportRow[],
  recommendCount = 15,
  opts?: { watchlist?: ExportRow[]; abandoned?: ExportRow[] },
): string {
  return `${tasteSummary(rows, opts)}\n\nTask: Based on what I've rated highly and the patterns across the lists above, recommend ${recommendCount} titles (mix of films and TV) that I have NOT seen and that are NOT already on my watchlist. For each one, write: Title (Year): one specific sentence on why it fits my taste, referencing things I rated highly. Order from most to least confident. Skip the obvious blockbusters unless they genuinely match.`;
}

export const FORMATS = [
  { key: "ai", label: "AI prompt", ext: "txt", mime: "text/plain" },
  { key: "text", label: "Text", ext: "txt", mime: "text/plain" },
  { key: "markdown", label: "Markdown", ext: "md", mime: "text/markdown" },
  { key: "json", label: "JSON", ext: "json", mime: "application/json" },
  { key: "xlsx", label: "Excel", ext: "xlsx", mime: "" },
] as const;

export type FormatKey = (typeof FORMATS)[number]["key"];

export function buildContent(format: Exclude<FormatKey, "xlsx">, rows: ExportRow[]): string {
  switch (format) {
    case "ai":
      return toAiPrompt(rows);
    case "text":
      return toText(rows);
    case "markdown":
      return toMarkdown(rows);
    case "json":
      return toJson(rows);
  }
}
