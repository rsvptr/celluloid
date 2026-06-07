import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { MediaType } from "@/generated/prisma/client";
import { getExportRows } from "@/lib/data";
import { tasteSummary } from "@/lib/export/format";
import { searchByType } from "@/lib/tmdb";
import { norm, yearOf, pickBest, nameYearKey } from "@/lib/tmdb-match";
import { anthropicClient, resolveAnthropicKey } from "@/lib/anthropic";
import { DEFAULT_REC_MODEL, isRecModel, MODEL_CAPS } from "@/lib/models";

export interface Recommendation {
  title: string;
  year: number | null;
  mediaType: "movie" | "tv";
  reason: string;
  confidence: "high" | "medium" | "low";
  tmdbId?: number;
  posterPath?: string | null;
  language?: string | null;
}

export interface RecommendBasis {
  /** What the suggestions are derived from: the whole library, recent watches, or a hand-picked set. */
  mode: "all" | "recent" | "pick";
  /** For `recent`: how many of the most recent watches to use. */
  recentCount?: number;
  /** For `pick`: the title ids to base recommendations on. */
  ids?: string[];
}

export interface RecommendOptions {
  count?: number;
  type?: "all" | "movie" | "tv";
  focus?: string;
  /** Explicit model for this run (validated); falls back to the user's saved default. */
  model?: string;
  /** Optional scope for which titles inform the recommendation. */
  basis?: RecommendBasis;
  /** Titles already shown this session, so a "show different" run skips them. */
  exclude?: string[];
}

export interface RecommendResult {
  recommendations?: Recommendation[];
  error?: string;
}

const REC_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          year: { type: ["integer", "null"] },
          mediaType: { type: "string", enum: ["movie", "tv"] },
          reason: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["title", "year", "mediaType", "reason", "confidence"],
      },
    },
  },
  required: ["recommendations"],
};

function buildPrompt(
  summary: string,
  count: number,
  type: "all" | "movie" | "tv",
  focus?: string,
  exclude?: string[],
): string {
  const typeClause =
    type === "movie"
      ? "Recommend films only."
      : type === "tv"
        ? "Recommend TV shows only."
        : "Recommend a mix of films and TV shows.";
  const focusClause = focus?.trim()
    ? ` Pay special attention to this request: "${focus.trim()}".`
    : "";
  const excludeClause =
    exclude && exclude.length
      ? ` I have already been shown these, so do NOT suggest any of them again: ${exclude.slice(0, 80).join(", ")}.`
      : "";
  return `${summary}\n\nBased on what I've rated highly and the patterns above, recommend ${count} titles I have NOT seen and that are NOT already on my watchlist.${focusClause}${excludeClause} ${typeClause} Strongly prefer titles that match what I rated highly; avoid obvious blockbusters unless they genuinely fit. Give each a specific one-sentence reason tied to my taste, plus a confidence level. Use the year of original release. Order from most to least confident.`;
}

/** Defensive shape check for a model-produced recommendation. */
function isValidRec(x: unknown): x is Recommendation {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.title === "string" &&
    r.title.trim().length > 0 &&
    (r.mediaType === "movie" || r.mediaType === "tv") &&
    typeof r.reason === "string" &&
    r.reason.trim().length > 0 &&
    (r.confidence === "high" || r.confidence === "medium" || r.confidence === "low")
  );
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length || 1) }, worker),
  );
  return out;
}

export async function generateRecommendations(
  userId: string,
  opts: RecommendOptions = {},
): Promise<RecommendResult> {
  const count = Math.min(30, Math.max(1, opts.count ?? 12));
  const type = opts.type ?? "all";

  const key = await resolveAnthropicKey(userId);
  if (!key) {
    return {
      error:
        "No Anthropic API key found. Add one in Settings to use AI recommendations.",
    };
  }

  const rows = await getExportRows(userId);
  if (rows.length === 0) {
    return { error: "Add a few titles first so the AI has something to learn from." };
  }

  // Precedence: explicit per-run model > the user's saved default > server default.
  let model = DEFAULT_REC_MODEL;
  if (isRecModel(opts.model)) {
    model = opts.model;
  } else {
    const userPref = await prisma.user.findUnique({
      where: { id: userId },
      select: { recommendModel: true },
    });
    if (isRecModel(userPref?.recommendModel)) model = userPref!.recommendModel!;
  }
  // Fail safe if a model is ever added to REC_MODELS without a caps entry.
  const caps = MODEL_CAPS[model] ?? { effort: false, adaptiveThinking: false };

  // Scope which titles inform the suggestions. The watchlist exclusion always
  // uses the full library so "don't recommend what I've already planned" holds
  // even when the basis is a subset.
  const fullWatchlist = rows.filter((r) => r.statusKey === "WATCHLIST");
  const fullAbandoned = rows.filter((r) => r.statusKey === "DROPPED");
  let basisRows = rows;
  const basis = opts.basis;
  if (basis?.mode === "recent") {
    const n = Math.min(200, Math.max(1, basis.recentCount ?? 20));
    basisRows = [...rows]
      .filter((r) => r.statusKey !== "WATCHLIST")
      .sort((a, b) =>
        (b.watchedAt ?? b.createdAt).localeCompare(a.watchedAt ?? a.createdAt),
      )
      .slice(0, n);
  } else if (basis?.mode === "pick") {
    const idSet = new Set(basis.ids ?? []);
    basisRows = rows.filter((r) => idSet.has(r.id));
    if (basisRows.length === 0) {
      return { error: "Pick at least one title to base recommendations on." };
    }
  }

  // Over-ask generously so type/in-library/dedup/exclude attrition (which grows
  // as "Show different" accumulates) still leaves ~count usable results. Type-
  // constrained runs lose more: the model often returns a mix that the post-filter
  // halves, so ask harder when a single type is requested.
  const askCount = Math.min(50, type === "all" ? count * 2 : count * 3 + 10);
  const prompt = buildPrompt(
    tasteSummary(basisRows, { watchlist: fullWatchlist, abandoned: fullAbandoned }),
    askCount,
    type,
    opts.focus,
    opts.exclude,
  );

  let recs: Recommendation[];
  try {
    const client = anthropicClient(key);
    // Stream so long outputs don't trip the route's request timeout.
    const res = await client.messages
      .stream({
        model,
        max_tokens: 16000,
        // Opus/Sonnet take adaptive thinking; Haiku 4.5 doesn't.
        ...(caps.adaptiveThinking
          ? { thinking: { type: "adaptive" as const } }
          : {}),
        output_config: {
          // `effort` 400s on Haiku 4.5 — only send it where supported.
          ...(caps.effort ? { effort: "medium" as const } : {}),
          format: { type: "json_schema", schema: REC_SCHEMA },
        },
        messages: [{ role: "user", content: prompt }],
      })
      .finalMessage();
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        error: "The AI response couldn't be read. Please try again.",
      };
    }
    const list = (parsed as { recommendations?: unknown })?.recommendations;
    recs = Array.isArray(list) ? list.filter(isValidRec) : [];
    if (recs.length === 0) {
      return {
        error:
          "The AI didn't return any usable suggestions. Try again, or tweak your focus.",
      };
    }
  } catch (e) {
    console.error("Recommendation request failed:", e);
    return { error: `AI request failed: ${(e as Error).message}` };
  }

  if (type !== "all") recs = recs.filter((r) => r.mediaType === type);

  // Drop near-duplicate suggestions (e.g. two spellings of the same film).
  const recSeen = new Set<string>();
  recs = recs.filter((r) => {
    const k = nameYearKey(r.mediaType, r.title, r.year);
    if (recSeen.has(k)) return false;
    recSeen.add(k);
    return true;
  });

  // Two ways to detect "I already own this": by TMDB id (matched titles) and by
  // normalized name+year (covers unmatched titles, common for regional films).
  const existing = await prisma.title.findMany({
    where: { userId, tmdbId: { not: null } },
    select: { tmdbId: true, mediaType: true },
  });
  const existingSet = new Set(existing.map((e) => `${e.mediaType}:${e.tmdbId}`));
  const libNameYear = new Set(
    rows.map((r) => nameYearKey(r.mediaType, r.name, r.year)),
  );
  // Titles already shown this session (a "show different" run), matched by name.
  const excludeSet = new Set((opts.exclude ?? []).map((t) => norm(t)));

  const enriched = await mapLimit(recs, 6, async (r): Promise<Recommendation | null> => {
    // Already in the library by name+year (matched or not)? Skip it.
    if (libNameYear.has(nameYearKey(r.mediaType, r.title, r.year))) return null;
    // Already shown this session? Skip it.
    if (excludeSet.has(norm(r.title))) return null;
    try {
      const results = await searchByType(r.mediaType, r.title);
      const best = pickBest(results, r.title, r.year);
      if (!best) return r;
      const mt = r.mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;
      if (existingSet.has(`${mt}:${best.id}`)) return null; // already in library
      const resolvedYear = r.year ?? yearOf(best);
      // TMDB may supply a year the model omitted; re-check ownership with it.
      if (libNameYear.has(nameYearKey(r.mediaType, r.title, resolvedYear))) return null;
      return {
        ...r,
        tmdbId: best.id,
        posterPath: best.poster_path ?? null,
        year: resolvedYear,
        language: best.original_language ?? null,
      };
    } catch {
      return r;
    }
  });

  // Surface the model's strongest picks first and, crucially, sort BEFORE the
  // slice so attrition can't drop a high-confidence rec while keeping a low one.
  const confRank = { high: 0, medium: 1, low: 2 } as const;
  return {
    recommendations: enriched
      .filter((r): r is Recommendation => r !== null)
      .sort((a, b) => (confRank[a.confidence] ?? 3) - (confRank[b.confidence] ?? 3))
      .slice(0, count),
  };
}
