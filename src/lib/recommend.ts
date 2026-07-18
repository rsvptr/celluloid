import { prisma } from "@/lib/prisma";
import { MediaType } from "@/generated/prisma/client";
import { getExportRows } from "@/lib/data";
import { tasteSummary, type ExportRow } from "@/lib/export/format";
import { searchByType, type TmdbSearchItem } from "@/lib/tmdb";
import { norm, yearOf, pickBest, nameYearKey } from "@/lib/tmdb-match";
import {
  anthropicClient,
  friendlyAnthropicError,
  resolveAnthropicKey,
} from "@/lib/anthropic";
import { createRecExtractor } from "@/lib/rec-stream";
import {
  DEFAULT_REC_MODEL,
  eraById,
  isRecModel,
  MODEL_CAPS,
  type RecEraId,
} from "@/lib/models";
import { languageName } from "@/lib/format";

export interface Recommendation {
  title: string;
  year: number | null;
  mediaType: "movie" | "tv";
  reason: string;
  confidence: "high" | "medium" | "low";
  tmdbId?: number;
  posterPath?: string | null;
  /** ISO-639-1 original language: TMDB-confirmed when matched, else the model's claim. */
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
  /** Prefer suggestions originally in this language (ISO code). */
  language?: string;
  /** Prefer suggestions in this genre. */
  genre?: string;
  /** Prefer suggestions from this era (validated RecEraId). */
  era?: RecEraId;
}

/** Events emitted over the recommendation stream (NDJSON lines on the wire). */
export type RecStreamEvent =
  | { type: "status"; phase: "thinking" | "generating" }
  | { type: "rec"; rec: Recommendation }
  | { type: "warning"; message: string }
  | { type: "done"; total: number }
  | { type: "error"; error: string };

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
          language: {
            type: ["string", "null"],
            description: "ISO-639-1 code of the title's original language",
          },
          reason: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["title", "year", "mediaType", "language", "reason", "confidence"],
      },
    },
  },
  required: ["recommendations"],
};

// Static so the prompt prefix stays byte-identical across runs (prompt cache).
const SYSTEM_PROMPT = `You are a film and TV curator with deep, worldwide knowledge of cinema — mainstream and regional, classic and current. You are given one person's complete watch history and asked for recommendations.

Rules:
- Recommend only real, released titles. Use the year of ORIGINAL release (first air date for TV).
- Report each title's original language as an ISO-639-1 code.
- Never recommend anything in the person's history or watchlist, anything they were already shown, or near-duplicates of either (remakes/re-releases count as duplicates only if they are the same work).
- Titles rated 8+ and favorites are the strongest positive signal; low ratings, abandoned and dropped titles describe what to avoid; recent watches describe current mood.
- Write each reason as ONE specific sentence tied to named titles or clear patterns in their history — never generic praise.
- Be honest with confidence: "high" only when the fit is strong and specific.
- If a hard requirement is given (language, genre, era, type), every suggestion must satisfy it.
- Order the list from most to least confident.`;

/** The cacheable part of the user turn: the taste brief. */
function buildBriefBlock(summary: string): string {
  return `${summary}`;
}

/** The volatile part of the user turn: this run's specific ask. */
export function buildRequestBlock(
  count: number,
  type: "all" | "movie" | "tv",
  focus?: string,
  exclude?: string[],
  language?: string,
  genre?: string,
  era?: RecEraId,
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
  const prefClause = [
    language ? `originally in ${languageName(language)}` : "",
    genre ? `in the ${genre} genre` : "",
    era ? eraById(era).clause : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const preferClause = prefClause
    ? ` Hard requirement: every suggestion must be ${prefClause}.`
    : "";
  return `Based on my taste brief above, recommend ${count} titles I have NOT seen and that are NOT already on my watchlist.${focusClause}${preferClause}${excludeClause} ${typeClause} Strongly prefer titles that match what I rated highly; avoid obvious blockbusters unless they genuinely fit. Return the full ${count} suggestions: when you run out of strong fits, include lower-confidence picks and label their confidence honestly rather than shortening the list.`;
}

/**
 * Select the basis rows for `mode: "recent"`: the most recently watched
 * titles, excluding the watchlist and — critically — anything with no real
 * watch date. Falling back to createdAt would let a freshly imported title
 * with no watch history masquerade as a recent watch just because its row is
 * new; a null watchedAt is simply excluded instead.
 */
export function selectRecentBasis(rows: ExportRow[], recentCount?: number): ExportRow[] {
  const n = Math.min(200, Math.max(1, recentCount ?? 20));
  return [...rows]
    .filter((r) => r.statusKey !== "WATCHLIST" && r.watchedAt !== null)
    .sort((a, b) => b.watchedAt!.localeCompare(a.watchedAt!))
    .slice(0, n);
}

/** Defensive shape check for a model-produced recommendation. */
export function isValidRec(x: unknown): x is Recommendation {
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

export interface StreamContext {
  existingSet: Set<string>;
  libNameYear: Set<string>;
  excludeSet: Set<string>;
  seenKeys: Set<string>;
}

/** The TMDB lookup enrichRec depends on; injectable so it can be stubbed in tests. */
type TitleSearch = (
  mediaType: "movie" | "tv",
  title: string,
) => Promise<TmdbSearchItem[]>;

/**
 * Try to enrich one model suggestion with its TMDB match. Returns null when the
 * suggestion turns out to already be in the library; returns the (possibly
 * unenriched) rec otherwise. `search` defaults to the real TMDB client and is
 * only overridden in tests.
 */
export async function enrichRec(
  r: Recommendation,
  ctx: StreamContext,
  search: TitleSearch = searchByType,
): Promise<Recommendation | null> {
  try {
    const results = await search(r.mediaType, r.title);
    const best = pickBest(results, r.title, r.year);
    if (!best) return r;
    const mt = r.mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;
    if (ctx.existingSet.has(`${mt}:${best.id}`)) return null; // already in library
    const resolvedYear = r.year ?? yearOf(best);
    // TMDB may supply a year the model omitted; re-check ownership with it.
    if (ctx.libNameYear.has(nameYearKey(r.mediaType, r.title, resolvedYear))) return null;
    return {
      ...r,
      tmdbId: best.id,
      posterPath: best.poster_path ?? null,
      year: resolvedYear,
      // TMDB's language is authoritative; fall back to the model's claim.
      language: best.original_language ?? r.language ?? null,
    };
  } catch {
    return r;
  }
}

// Streaming output-token ceilings per recommend model. max_tokens scales with
// the ask below but is always kept a safe margin under these so a large batch
// plus adaptive thinking can't be rejected or silently truncated. A model with
// no entry falls back to the smallest ceiling.
const MODEL_OUTPUT_CEILING: Record<string, number> = {
  "claude-opus-4-8": 128000,
  "claude-sonnet-5": 128000,
  "claude-haiku-4-5": 64000,
};

/**
 * Run one recommendation request end to end, emitting events as results become
 * available: the Claude response streams in, each completed suggestion is
 * validated, deduped and TMDB-enriched immediately, and generation is aborted
 * early once enough suggestions have been accepted (saving tokens and time).
 */
export async function runRecommendationStream(
  userId: string,
  opts: RecommendOptions,
  emit: (e: RecStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const count = Math.min(30, Math.max(1, opts.count ?? 12));
  const type = opts.type ?? "all";

  // If the client already went away before we did any work, stop here. Every
  // await below re-checks, so we never start — or keep paying for — a run for a
  // request no one is listening to. Bailing is a clean, error-free return.
  if (signal?.aborted) return;

  const { key, usedFallback, hadUserKey } = await resolveAnthropicKey(userId);
  if (!key) {
    emit({
      type: "error",
      error: "No Anthropic API key found. Add one in Settings to use AI recommendations.",
    });
    return;
  }
  if (signal?.aborted) return;
  // The user's own key exists but wouldn't decrypt, so we're silently on the
  // deployment default — tell them once, without failing the run. "No user key
  // at all" is the normal case and stays quiet.
  if (usedFallback && hadUserKey) {
    emit({
      type: "warning",
      message:
        "Your saved API key couldn't be used; falling back to the default. Re-enter it in Settings.",
    });
  }

  const rows = await getExportRows(userId);
  if (rows.length === 0) {
    emit({
      type: "error",
      error: "Add a few titles first so Claude has something to learn from.",
    });
    return;
  }
  if (signal?.aborted) return;

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
  if (signal?.aborted) return;
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
    basisRows = selectRecentBasis(rows, basis.recentCount);
  } else if (basis?.mode === "pick") {
    const idSet = new Set(basis.ids ?? []);
    basisRows = rows.filter((r) => idSet.has(r.id));
    if (basisRows.length === 0) {
      emit({ type: "error", error: "Pick at least one title to base recommendations on." });
      return;
    }
  }

  // Over-ask so type/in-library/dedup/exclude attrition still leaves ~count
  // usable results. Generation is aborted the moment `count` are accepted, so
  // the over-ask costs nothing when attrition turns out to be low.
  const hasPref = !!(opts.language || opts.genre || opts.era);
  const baseAsk = type === "all" ? count * 2 : count * 3 + 10;
  const askCount = Math.min(50, hasPref ? baseAsk + 10 : baseAsk);

  const brief = buildBriefBlock(
    tasteSummary(basisRows, { watchlist: fullWatchlist, abandoned: fullAbandoned }),
  );
  const request = buildRequestBlock(
    askCount,
    type,
    opts.focus,
    opts.exclude,
    opts.language,
    opts.genre,
    opts.era,
  );

  // Dedup / ownership context shared by every suggestion in this run. Trashed
  // titles are excluded (deletedAt: null) so a soft-deleted title no longer blocks
  // being recommended again — consistent with it being absent from the taste brief,
  // which is built from getExportRows (also deletedAt-filtered).
  const existing = await prisma.title.findMany({
    where: { userId, tmdbId: { not: null }, deletedAt: null },
    select: { tmdbId: true, mediaType: true },
  });
  if (signal?.aborted) return;
  const ctx: StreamContext = {
    existingSet: new Set(existing.map((e) => `${e.mediaType}:${e.tmdbId}`)),
    libNameYear: new Set(rows.map((r) => nameYearKey(r.mediaType, r.name, r.year))),
    excludeSet: new Set((opts.exclude ?? []).map((t) => norm(t))),
    seenKeys: new Set(),
  };

  // Scale the output budget with the ask so a large batch (askCount up to 50)
  // plus adaptive thinking — which draws from the same ceiling — can't truncate
  // mid-JSON. The base (~the old flat budget) covers thinking + the JSON
  // envelope; the per-item budget covers each suggestion and its share of
  // thinking. Capped a safe margin under the model's streaming ceiling. This is a
  // ceiling, not a target: generation is aborted once `count` are accepted, so
  // the headroom only prevents truncation, it never costs tokens.
  const outputCeiling = MODEL_OUTPUT_CEILING[model] ?? 64000;
  const maxTokens = Math.min(outputCeiling - 8000, 16000 + askCount * 800);

  const client = anthropicClient(key);
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    // Opus / Sonnet take adaptive thinking; Haiku 4.5 doesn't.
    ...(caps.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: {
      // `effort` 400s on Haiku 4.5 — only send it where supported.
      ...(caps.effort ? { effort: "medium" as const } : {}),
      format: { type: "json_schema", schema: REC_SCHEMA },
    },
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: brief,
            // Cache breakpoint AFTER the brief: system + brief form a stable
            // prefix, so "Show different" and preset re-runs within the TTL
            // reprocess only the short run request below (~90% cheaper, faster
            // time-to-first-suggestion).
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: request },
        ],
      },
    ],
  });
  if (signal) {
    // Client went away (or asked to stop): stop paying for generation. Guard the
    // race where the signal fired between the last checkpoint and here — a fresh
    // "abort" would never fire on an already-aborted signal, so abort directly.
    if (signal.aborted) stream.abort();
    else signal.addEventListener("abort", () => stream.abort(), { once: true });
  }

  const extractor = createRecExtractor();
  let accepted = 0;
  let statusSent: "thinking" | "generating" | null = null;
  let stopped = false; // no further emits once set (enough results, or a failure)
  let hitMaxTokens = false; // model ran into the output ceiling (budget exhausted)
  // Round-robin lanes bound enrichment concurrency: a model that bursts out 40
  // suggestions can't burst-fire 40 TMDB searches at once.
  const lanes: Promise<void>[] = Array.from({ length: 5 }, () => Promise.resolve());
  let nextLane = 0;

  const handleParsed = (raw: unknown) => {
    if (stopped || accepted >= count) return;
    if (!isValidRec(raw)) return;
    const rec = raw as Recommendation;
    // Near-duplicate of an earlier suggestion this run?
    const k = nameYearKey(rec.mediaType, rec.title, rec.year);
    if (ctx.seenKeys.has(k)) return;
    ctx.seenKeys.add(k);
    // Already shown this session, or already in the library by name+year?
    if (ctx.excludeSet.has(norm(rec.title))) return;
    if (ctx.libNameYear.has(k)) return;
    if (opts.type && opts.type !== "all" && rec.mediaType !== opts.type) return;

    // Enrich concurrently with parsing; emit the moment each one resolves.
    const lane = nextLane++ % lanes.length;
    lanes[lane] = lanes[lane].then(async () => {
      if (stopped || accepted >= count) return;
      const r = await enrichRec(rec, ctx);
      if (!r || stopped || accepted >= count) return;
      accepted++;
      emit({ type: "rec", rec: r });
      if (accepted >= count) {
        // Enough accepted — stop the model mid-generation to save tokens.
        stopped = true;
        stream.abort();
      }
    });
  };

  try {
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "thinking" && statusSent === null) {
          statusSent = "thinking";
          emit({ type: "status", phase: "thinking" });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          if (statusSent !== "generating") {
            statusSent = "generating";
            emit({ type: "status", phase: "generating" });
          }
          for (const item of extractor.push(event.delta.text)) handleParsed(item);
        }
      } else if (event.type === "message_delta") {
        // The final message_delta carries the stop reason. "max_tokens" means the
        // budget was exhausted mid-generation (likely truncating the JSON), which
        // needs a specific message rather than the generic "no results" below.
        if (event.delta.stop_reason === "max_tokens") hitMaxTokens = true;
      }
    }
  } catch (e) {
    // An abort we triggered (enough results) or the client triggered is not an
    // error; anything else gets a friendly explanation. Partial results already
    // emitted stay valid — the client keeps them alongside the error.
    if (!stopped && !signal?.aborted) {
      stopped = true;
      await Promise.allSettled(lanes);
      console.error("Recommendation request failed:", e);
      emit({ type: "error", error: friendlyAnthropicError(e) });
      return;
    }
  }

  await Promise.allSettled(lanes);
  if (accepted === 0) {
    emit({
      type: "error",
      error: hitMaxTokens
        ? "Claude ran out of room before finishing a single suggestion. Ask for fewer titles, or pick a shorter focus, and try again."
        : "Claude didn't return any usable suggestions. Try again, or tweak your focus.",
    });
    return;
  }
  // Got some, but the model hit the token ceiling before the full batch — let the
  // user know the short list is a budget limit, not a lack of ideas.
  if (hitMaxTokens && accepted < count) {
    emit({
      type: "warning",
      message: `Claude hit its length limit after ${accepted} of ${count} suggestions. Ask for fewer titles for a complete set.`,
    });
  }
  emit({ type: "done", total: accepted });
}
