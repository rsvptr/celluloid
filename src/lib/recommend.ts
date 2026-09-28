import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { MediaType } from "@/generated/prisma/client";
import { getExportRows } from "@/lib/data";
import { tasteSummary, type ExportRow } from "@/lib/export/format";
import {
  getGenreIdsByName,
  searchByType,
  type SearchOptions,
  type TmdbSearchItem,
} from "@/lib/tmdb";
import { norm, yearOf, pickBest, nameYearKey } from "@/lib/tmdb-match";
import {
  anthropicClient,
  friendlyAnthropicError,
  releaseSharedAiRun,
  reserveSharedAiRun,
  resolveAnthropicKey,
} from "@/lib/anthropic";
import { createRecExtractor } from "@/lib/rec-stream";
import {
  eraById,
  isRecModel,
  MODEL_CACHE_MIN_TOKENS,
  MODEL_CAPS,
  resolveRecModel,
  type RecEraId,
  type RecModelId,
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

/** One row of the owner's durable "not interested" list. */
export interface SuppressionRow {
  tmdbId: number | null;
  mediaType: MediaType;
  name: string;
  year: number | null;
}

/**
 * The "not interested" list in the two shapes a run needs: lookup sets to filter
 * suggestions against, and the most recent names to warn the model off up front.
 */
export interface SuppressionContext {
  /** `<MediaType>:<tmdbId>` for suppressions that resolved to a TMDB entry. */
  tmdbKeys: Set<string>;
  /** nameYearKey() for every suppression, TMDB-resolved or not. */
  nameKeys: Set<string>;
  /** Suppressed names, most recent first, for the prompt's exclusion clause. */
  recentNames: string[];
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

const THINKING_HEARTBEAT_MS = 5_000;
export const RECOMMEND_KEEPALIVE_MS = 10_000;
const MAX_PENDING_RECOMMENDATIONS = 50;

/** Keep the wire alive during extended-thinking stretches without flooding it. */
export function shouldSendThinkingHeartbeat(
  lastHeartbeatAt: number | null,
  now: number,
): boolean {
  return lastHeartbeatAt === null || now - lastHeartbeatAt >= THINKING_HEARTBEAT_MS;
}

const SHARED_AI_LIMIT_REACHED =
  "The app's shared AI allowance is used up for today. Add a personal Anthropic API key in Settings to keep going, or try again after 00:00 UTC.";

/** Own-key runs bypass the shared counter entirely. */
export async function sharedAiBudgetError(
  usedFallback: boolean,
  reserve: typeof reserveSharedAiRun = reserveSharedAiRun,
): Promise<string | null> {
  if (!usedFallback) return null;
  const reservation = await reserve();
  return reservation.allowed ? null : SHARED_AI_LIMIT_REACHED;
}

/** Explain when a requested genre has no strict TMDB mapping for this medium. */
export function genreFilterAdvisory(
  genre: string | undefined,
  type: "all" | "movie" | "tv",
  genreIds: ReadonlySet<number> | null | undefined,
): string | null {
  if (!genre || genreIds === null || genreIds === undefined || genreIds.size > 0) {
    return null;
  }
  const scope = type === "movie" ? "movies" : type === "tv" ? "TV" : "movies or TV";
  return `TMDB doesn't list “${genre}” for ${scope}, so Celluloid treated it as guidance instead of a strict filter for this run.`;
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
const SYSTEM_PROMPT = `You are a film and TV curator with deep, worldwide knowledge of cinema — mainstream and regional, classic and current. You are given one person's watch history and asked for recommendations.

Rules:
- Recommend only real, released titles. Use the year of original release (first air date for TV).
- Report each title's original language as an ISO-639-1 code.
- Never recommend anything in the person's history or watchlist, anything they were already shown, or near-duplicates of either (remakes/re-releases count as duplicates only if they are the same work).
- Rewatches, titles rated 8+ and favorites are the strongest positive signal; low ratings, abandoned and dropped titles describe what to avoid; recent watches describe current mood.
- Write each reason as one specific sentence tied to named titles or clear patterns in their history — never generic praise.
- Be honest with confidence: "high" only when the fit is strong and specific.
- If a hard requirement is given (language, genre, era, type), every suggestion must satisfy it.
- Order the list from most to least confident.`;

/** The cacheable part of the user turn: the taste brief. */
function buildBriefBlock(summary: string): string {
  return `${summary}`;
}

/**
 * How many titles the "don't suggest these" clause carries. Naming the cap
 * lets mergeExcludeNames fill it deliberately instead of guessing at the slice
 * below.
 */
export const PROMPT_EXCLUDE_CAP = 80;

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
      ? ` I have already been shown these, so don't suggest any of them again: ${exclude.slice(0, PROMPT_EXCLUDE_CAP).join(", ")}.`
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
  return `Based on my taste brief above, recommend ${count} titles I haven't seen and that aren't already on my watchlist.${focusClause}${preferClause}${excludeClause} ${typeClause} Strongly prefer titles that match what I rated highly; avoid obvious blockbusters unless they genuinely fit. Return the full ${count} suggestions: when you run out of strong fits, include lower-confidence picks and label their confidence honestly rather than shortening the list.`;
}

/**
 * The durable identity of a suppressed suggestion. A suggestion that resolved to
 * TMDB keys on that id; everything else keys on normalized name + year, because
 * a regional title often never resolves at all and those are exactly the ones
 * worth remembering a refusal for. Both shapes are built from `norm`, the same
 * normalization the run-time de-duplication uses, so the stored key and the
 * filter can't drift apart.
 */
export function suppressionMatchKey(input: {
  mediaType: "movie" | "tv";
  tmdbId?: number | null;
  name: string;
  year?: number | null;
}): string {
  const mt = input.mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;
  if (input.tmdbId != null) return `tmdb:${mt}:${input.tmdbId}`;
  return `name:${input.mediaType}:${norm(input.name)}|${input.year ?? "?"}`;
}

/** Build the run-time lookup sets from suppression rows. */
export function suppressionContext(rows: SuppressionRow[]): SuppressionContext {
  const tmdbKeys = new Set<string>();
  const nameKeys = new Set<string>();
  const recentNames: string[] = [];
  for (const row of rows) {
    if (row.tmdbId != null) tmdbKeys.add(`${row.mediaType}:${row.tmdbId}`);
    // Indexed by name as well as id: a suggestion is name-checked before the
    // TMDB lookup, so a suppressed title usually never costs a search at all.
    nameKeys.add(
      nameYearKey(row.mediaType === MediaType.TV ? "tv" : "movie", row.name, row.year),
    );
    recentNames.push(row.name);
  }
  return { tmdbKeys, nameKeys, recentNames };
}

/**
 * Ceiling on suppressions pulled into one run. This is a resource guard for a
 * list that only ever grows; the newest refusals are the ones most likely to
 * come back around, so an owner past the ceiling still gets the ones that matter.
 */
export const MAX_SUPPRESSIONS_LOADED = 2000;

/** Load the owner's "not interested" list, newest first. */
export async function loadSuppressions(userId: string): Promise<SuppressionContext> {
  const rows = await prisma.suppression.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: MAX_SUPPRESSIONS_LOADED,
    select: { tmdbId: true, mediaType: true, name: true, year: true },
  });
  return suppressionContext(rows);
}

/**
 * Does this suggestion match something the owner turned down? A suppression
 * stored without a year matches that name in any year — the year is precisely
 * what we don't know about it — while a suppression that has a year matches only
 * that year, so refusing the 2011 remake doesn't also bury the 1982 original.
 */
export function isSuppressedByName(
  suppressed: SuppressionContext | undefined,
  mediaType: "movie" | "tv",
  title: string,
  year: number | null | undefined,
): boolean {
  if (!suppressed) return false;
  return (
    suppressed.nameKeys.has(nameYearKey(mediaType, title, year)) ||
    suppressed.nameKeys.has(nameYearKey(mediaType, title, null))
  );
}

/**
 * Slots the exclusion clause reserves for durable rejections. Without a reserve,
 * a long browsing session's "already shown" titles would fill the clause and the
 * model would keep re-proposing titles the owner explicitly refused — which is
 * the expensive case, since filtering those out costs a TMDB lookup each.
 */
const SUPPRESSED_NAME_SLOTS = 30;

/**
 * Fold this session's shown titles and the durable rejections into the single
 * exclusion clause the prompt has room for. Session titles go first (they carry
 * the "show me different ones" intent), suppressions take their reserved slots,
 * and any slots the suppressions don't use go back to the session titles.
 */
export function mergeExcludeNames(seen: string[], suppressedNames: string[]): string[] {
  const out: string[] = [];
  const taken = new Set<string>();
  const push = (title: string) => {
    const key = norm(title);
    if (!key || taken.has(key) || out.length >= PROMPT_EXCLUDE_CAP) return;
    taken.add(key);
    out.push(title);
  };
  const reserved = Math.min(SUPPRESSED_NAME_SLOTS, suppressedNames.length);
  for (const title of seen.slice(0, PROMPT_EXCLUDE_CAP - reserved)) push(title);
  for (const title of suppressedNames) push(title);
  for (const title of seen) push(title);
  return out;
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
  /** TMDB identities already accepted by enrichment in this run. */
  resolvedKeys?: Set<string>;
  /**
   * The owner's "not interested" list. Optional so a context assembled without a
   * suppression load behaves exactly as it did before this layer existed.
   */
  suppressed?: SuppressionContext;
  /**
   * The run's hard requirements, enforced against TMDB's authoritative fields
   * after enrichment — the prompt calls them hard, so the server must too.
   * `genreIds` is the TMDB id set for the requested genre name; null means the
   * mapping lookup failed and genre stays prompt-only for this run rather than
   * failing the whole stream.
   */
  requirements?: {
    language?: string;
    era?: { from: number; to: number };
    genreIds?: Set<number> | null;
  };
  /**
   * Mutable run tallies behind the terminal warnings: suggestions dropped for
   * violating a hard requirement, and TMDB lookups that errored (outage), which
   * must read differently to the user than a genuine no-match.
   */
  tallies?: { filteredOut: number; lookupFailed: number };
}

/** The TMDB lookup enrichRec depends on; injectable so it can be stubbed in tests. */
type TitleSearch = (
  mediaType: "movie" | "tv",
  title: string,
  page?: number,
  opts?: SearchOptions,
) => Promise<TmdbSearchItem[]>;

/**
 * Try to enrich one model suggestion with its TMDB match. Returns null when the
 * suggestion turns out to already be in the library; returns the (possibly
 * unenriched) rec otherwise. `search` defaults to the real TMDB client and is
 * only overridden in tests. `signal` is the run's abort signal, so a stopped
 * run cancels TMDB lookups already in flight instead of paying them out.
 */
/**
 * Enforce the run's hard requirements against the best available facts —
 * TMDB's fields once a suggestion resolves, the model's own claims when it
 * does not. A violation counts toward the terminal shortfall warning. Fields
 * nobody can verify (an unresolved title with no claimed language, a match
 * with no genre ids) pass: dropping the unverifiable would silently erase the
 * regional titles that resolve worst, which are often the point.
 */
function violatesRequirements(
  ctx: StreamContext,
  facts: { language: string | null; year: number | null; genreIds?: number[] },
): boolean {
  const req = ctx.requirements;
  if (!req) return false;
  if (req.language && facts.language && facts.language !== req.language) return true;
  if (req.era && facts.year != null && (facts.year < req.era.from || facts.year > req.era.to)) {
    return true;
  }
  if (
    req.genreIds instanceof Set &&
    req.genreIds.size > 0 &&
    facts.genreIds &&
    facts.genreIds.length > 0 &&
    !facts.genreIds.some((id) => (req.genreIds as Set<number>).has(id))
  ) {
    return true;
  }
  return false;
}

function dropFiltered(ctx: StreamContext): null {
  if (ctx.tallies) ctx.tallies.filteredOut += 1;
  return null;
}

export async function enrichRec(
  r: Recommendation,
  ctx: StreamContext,
  search: TitleSearch = searchByType,
  signal?: AbortSignal,
): Promise<Recommendation | null> {
  try {
    // The model's year narrows the search: without it a regional title
    // resolves to whichever entry TMDB ranks most popular, not the one asked for.
    const results = await search(r.mediaType, r.title, 1, {
      year: r.year,
      signal,
      deadlineMs: 10_000,
      retries: 1,
    });
    const best = pickBest(results, r.title, r.year);
    if (!best) {
      // Unresolved: hard requirements still apply to what the model CLAIMED —
      // a claim that already violates the ask cannot ship just because TMDB
      // couldn't confirm it.
      return violatesRequirements(ctx, { language: r.language ?? null, year: r.year })
        ? dropFiltered(ctx)
        : r;
    }
    const mt = r.mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;
    const resolvedKey = `${r.mediaType}:${best.id}`;
    const resolvedKeys = ctx.resolvedKeys ?? (ctx.resolvedKeys = new Set());
    if (resolvedKeys.has(resolvedKey)) return null;
    resolvedKeys.add(resolvedKey);
    if (ctx.existingSet.has(`${mt}:${best.id}`)) return null; // already in library
    // The refusal may have been recorded against a TMDB id, in which case only
    // the resolved match can see it — a name the model spelled differently, or
    // a year it got wrong, would have slipped past the name check upstream.
    if (ctx.suppressed?.tmdbKeys.has(`${mt}:${best.id}`)) return null;
    // TMDB's year is authoritative once a match is credible: the model's claim
    // narrowed the SEARCH, but emitting it verbatim shipped wrong years to the
    // card and the dedupe whenever the claim was off by a year or two.
    const resolvedYear = yearOf(best) ?? r.year;
    const resolvedTitle = r.mediaType === "tv" ? best.name : best.title;
    ctx.seenKeys.add(nameYearKey(r.mediaType, resolvedTitle ?? r.title, resolvedYear));
    // TMDB may supply a year the model omitted; re-check ownership with it.
    if (ctx.libNameYear.has(nameYearKey(r.mediaType, r.title, resolvedYear))) return null;
    if (isSuppressedByName(ctx.suppressed, r.mediaType, r.title, resolvedYear)) return null;
    const resolvedLanguage = best.original_language ?? r.language ?? null;
    if (
      violatesRequirements(ctx, {
        language: resolvedLanguage,
        year: resolvedYear,
        genreIds: best.genre_ids,
      })
    ) {
      return dropFiltered(ctx);
    }
    // "Only released titles" is a standing rule, not a per-run filter: a match
    // whose TMDB date sits in the future is an announcement, not a
    // recommendation. A missing date is left alone — plenty of obscure,
    // perfectly-released titles simply lack one.
    const dateStr = r.mediaType === "tv" ? best.first_air_date : best.release_date;
    if (dateStr && dateStr.slice(0, 10) > new Date().toISOString().slice(0, 10)) {
      return dropFiltered(ctx);
    }
    return {
      ...r,
      tmdbId: best.id,
      posterPath: best.poster_path ?? null,
      year: resolvedYear,
      // TMDB's language is authoritative; fall back to the model's claim.
      language: resolvedLanguage,
    };
  } catch {
    // An outage is not a no-match: the suggestion ships unverified, and the
    // run's terminal warning says so once — silently conflating the two made
    // "TMDB was down" indistinguishable from "this title doesn't exist".
    if (signal?.aborted) return null;
    if (violatesRequirements(ctx, { language: r.language ?? null, year: r.year })) {
      return dropFiltered(ctx);
    }
    if (ctx.tallies) ctx.tallies.lookupFailed += 1;
    return r;
  }
}

// Streaming output-token ceilings per recommend model. max_tokens scales with
// the ask below but is always kept a safe margin under these so a large batch
// plus adaptive thinking can't be rejected or silently truncated. A model with
// no entry falls back to the smallest ceiling.
const MODEL_OUTPUT_CEILING: Record<string, number> = {
  "claude-opus-5-5": 128000,
  "claude-sonnet-5": 128000,
  "claude-haiku-4-5": 64000,
};

// ~4 characters per token is close enough for English prose, and the taste
// brief is title names and short notes. Only used to decide whether to attach
// the prompt-cache breakpoint, so erring low costs at most one missed cache.
const APPROX_CHARS_PER_TOKEN = 4;

// The beta that gates `fallbacks: "default"`. The array form of `fallbacks`
// takes a different header (server-side-fallback-2026-06-01), and pairing
// either header with the other form is a 400.
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The Messages API request for one run on `model`. Pure, so each model's
 * request surface (thinking, effort, output budget, cache breakpoint, refusal
 * fallback) is unit-testable without a live stream. None of the models take
 * sampling parameters or an assistant prefill, and the JSON shape comes from
 * structured outputs, not a forced tool call.
 */
export function buildRecRequest(
  model: RecModelId,
  askCount: number,
  brief: string,
  request: string,
) {
  // Fail safe if a model is ever added to REC_MODELS without a caps entry.
  const caps = MODEL_CAPS[model] ?? {
    effort: false,
    adaptiveThinking: false,
    serverFallback: false,
  };

  // Scale the output budget with the ask so a large batch (askCount up to 50)
  // plus adaptive thinking — max_tokens is a single cap covering thinking AND
  // response text — can't truncate mid-JSON. The base (~the old flat budget)
  // covers thinking + the JSON envelope; the per-item budget covers each
  // suggestion and its share of thinking. Capped a safe margin under the
  // model's streaming ceiling. This is a ceiling, not a target: generation is
  // aborted once `count` are accepted, so the headroom only prevents
  // truncation, it never costs tokens.
  const outputCeiling = MODEL_OUTPUT_CEILING[model] ?? 64000;
  const maxTokens = Math.min(outputCeiling - 8000, 16000 + askCount * 800);

  // The cacheable prefix is system + brief, so both count toward the model's
  // minimum. Under it the breakpoint is silently ignored and we'd pay the
  // cache-write premium for nothing, so leave it off.
  const cacheMinTokens = MODEL_CACHE_MIN_TOKENS[model] ?? 4096;
  const briefIsCacheable =
    (SYSTEM_PROMPT.length + brief.length) / APPROX_CHARS_PER_TOKEN >= cacheMinTokens;

  return {
    model,
    max_tokens: maxTokens,
    // Opus / Sonnet take adaptive thinking; Haiku 4.5 doesn't. Opus 5.5 and
    // Sonnet 5 think adaptively even with the field omitted, but sending it
    // keeps the request shape identical across the models that support it.
    // Their thinking text streams empty (display defaults to "omitted"); the
    // run's "thinking" phase keys off the block start, not the text.
    ...(caps.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: {
      // `effort` 400s on Haiku 4.5 — only send it where supported. Opus 5.5
      // and Sonnet 5 take the full low|medium|high|xhigh|max ladder; "medium"
      // stays deliberate here because this is an interactive stream and the
      // higher rungs buy depth we don't need at the cost of time-to-first-card.
      // (Opus 5.5 defaults to medium and Sonnet 5 to high, so it is always sent.)
      ...(caps.effort ? { effort: "medium" as const } : {}),
      format: { type: "json_schema" as const, schema: REC_SCHEMA },
    },
    system: [{ type: "text" as const, text: SYSTEM_PROMPT }],
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: brief,
            // Cache breakpoint AFTER the brief: system + brief form a stable
            // prefix, so "Show different" and preset re-runs within the TTL
            // reprocess only the short run request below (~90% cheaper, faster
            // time-to-first-suggestion). Attached only for a library big enough
            // to clear the model's minimum — see briefIsCacheable above.
            ...(briefIsCacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
          },
          { type: "text" as const, text: request },
        ],
      },
    ],
    // A safety-classifier decline reruns server-side on the model Anthropic
    // recommends for that refusal category, on the same stream: a decline
    // before any output is seamless, and one mid-stream keeps the partial
    // text and continues from it. Only a refusal from every model in the
    // chain comes back as stop_reason "refusal".
    ...(caps.serverFallback
      ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" as const }
      : {}),
  } satisfies Anthropic.Beta.Messages.MessageCreateParams;
}

/**
 * What to emit once the model stream ends, given how many suggestions were
 * accepted and which stop-reason flags fired during the run. Pure — no stream
 * or network access — so the refusal/max_tokens/plain-empty priority is
 * unit-testable without a live Anthropic stream. runRecommendationStream's
 * tail is just `for (const e of terminalRecEvents(...)) emit(e)`.
 *
 * A refusal only produces its own error when nothing usable came out of the
 * run. If suggestions were already accepted before the model declined,
 * partial results beat an error: each one is a complete, validated pick, so
 * they stay, with a warning that the list stopped short rather than a silent
 * short list that reads as finished.
 */
export function terminalRecEvents(
  accepted: number,
  count: number,
  flags: {
    hitMaxTokens: boolean;
    hitRefusal: boolean;
    /** The caller ended the run, so it owns any terminal explanation. */
    aborted?: boolean;
    /** Suggestions dropped for violating a hard language/genre/era requirement. */
    filteredOut?: number;
    /** TMDB lookups that errored — those suggestions shipped unverified. */
    lookupFailed?: number;
  },
): RecStreamEvent[] {
  if (flags.aborted) return [];
  if (accepted === 0) {
    if (flags.hitRefusal) {
      return [
        {
          type: "error",
          error:
            "Claude declined this request. This can happen when the brief or focus text trips a safety filter, so reword it and try again.",
        },
      ];
    }
    return [
      {
        type: "error",
        error: flags.hitMaxTokens
          ? "Claude ran out of room before finishing a single suggestion. Ask for fewer titles, or pick a shorter focus, and try again."
          : "Claude didn't return any usable suggestions. Try again, or tweak your focus.",
      },
    ];
  }
  const events: RecStreamEvent[] = [];
  // Got some, but the model hit the token ceiling before the full batch — let
  // the user know the short list is a budget limit, not a lack of ideas.
  if (flags.hitMaxTokens && accepted < count) {
    events.push({
      type: "warning",
      message: `Claude hit its length limit after ${accepted} of ${count} suggestions. Ask for fewer titles for a complete set.`,
    });
  }
  if (flags.hitRefusal && accepted < count) {
    events.push({
      type: "warning",
      message: `Claude stopped after ${accepted} of ${count} suggestions and declined the rest. Reword your focus and run it again for a fuller list.`,
    });
  }
  // A TMDB outage must read differently to a genuine no-match: these
  // suggestions shipped as the model described them, unverified.
  if ((flags.lookupFailed ?? 0) > 0) {
    const n = flags.lookupFailed!;
    events.push({
      type: "warning",
      message: `TMDB couldn't be reached to verify ${n === 1 ? "one suggestion" : `${n} suggestions`}, so ${n === 1 ? "it's" : "they're"} shown as Claude described ${n === 1 ? "it" : "them"}. Details may be off.`,
    });
  }
  // Hard-requirement drops explain a short list; when the batch still filled,
  // the drops cost nothing worth interrupting the user about. "Requirements"
  // covers the user's language/genre/era filters AND the standing released-only
  // rule, so the copy names the check, not just the filters.
  if ((flags.filteredOut ?? 0) > 0 && accepted < count) {
    const n = flags.filteredOut!;
    events.push({
      type: "warning",
      message: `${n === 1 ? "One suggestion was" : `${n} suggestions were`} dropped for not meeting the request (unreleased, or outside your language/genre/era filters). Run again, or loosen a filter for a fuller list.`,
    });
  }
  events.push({ type: "done", total: accepted });
  return events;
}

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
  const stopController = new AbortController();
  const runSignal = signal
    ? AbortSignal.any([signal, stopController.signal])
    : stopController.signal;

  // If the client already went away before we did any work, stop here. Bailing
  // is a clean, error-free return.
  if (runSignal.aborted) return;

  // These lookups share only the user id and request options, so start them
  // together instead of adding several round trips before the stream begins.
  // Suppressions stay outside the cacheable brief even though they load here.
  const explicitModel = isRecModel(opts.model) ? opts.model : null;
  const hasPref = !!(opts.language || opts.genre || opts.era);
  const userPrefPromise = explicitModel
    ? Promise.resolve(null)
    : prisma.user.findUnique({
        where: { id: userId },
        select: { recommendModel: true },
      });
  const genreIdsPromise = opts.genre
    ? getGenreIdsByName(opts.genre, type === "all" ? ["movie", "tv"] : [type]).catch(
        () => null,
      )
    : Promise.resolve(undefined);
  const [keyInfo, rows, userPref, suppressed, existing, genreIds] = await Promise.all([
    resolveAnthropicKey(userId),
    getExportRows(userId),
    userPrefPromise,
    loadSuppressions(userId),
    prisma.title.findMany({
      where: { userId },
      select: {
        tmdbId: true,
        mediaType: true,
        name: true,
        releaseDate: true,
        deletedAt: true,
      },
    }),
    genreIdsPromise,
  ]);
  if (runSignal.aborted) return;

  const { key, usedFallback, hadUserKey } = keyInfo;
  if (!key) {
    emit({
      type: "error",
      error: "No Anthropic API key found. Add one in Settings to use AI recommendations.",
    });
    return;
  }
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
  const genreAdvisory = genreFilterAdvisory(opts.genre, type, genreIds);
  if (genreAdvisory) emit({ type: "warning", message: genreAdvisory });

  if (rows.length === 0) {
    emit({
      type: "error",
      error: "Add a few titles first so Claude has something to learn from.",
    });
    return;
  }
  // Precedence: explicit per-run model > the user's saved default > server
  // default. A saved default naming a retired model runs on its successor.
  const model = explicitModel ?? resolveRecModel(userPref?.recommendModel);

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
  const baseAsk = type === "all" ? count * 2 : count * 3 + 10;
  const askCount = Math.min(50, hasPref ? baseAsk + 10 : baseAsk);

  // The prompt calls language/genre/era HARD requirements, so the server
  // enforces them against TMDB's fields after enrichment rather than trusting
  // the model's compliance. The genre name→id mapping is best-effort: if the
  // lookup fails, genre stays prompt-only for this run instead of failing it.
  let requirements: StreamContext["requirements"];
  if (hasPref) {
    requirements = {};
    if (opts.language) requirements.language = opts.language;
    if (opts.era) {
      const era = eraById(opts.era);
      requirements.era = { from: era.range[0], to: era.range[1] };
    }
    if (opts.genre) requirements.genreIds = genreIds ?? null;
  }

  // A scoped basis means the watchlist/abandoned rows are OUTSIDE what the
  // owner chose to share this run — they enter the brief as bare identities
  // (exclusion needs nothing more), never with notes, ratings or tags.
  const scopedBasis = basis?.mode === "recent" || basis?.mode === "pick";
  const brief = buildBriefBlock(
    tasteSummary(basisRows, {
      watchlist: fullWatchlist,
      abandoned: fullAbandoned,
      exclusionIdentityOnly: scopedBasis,
    }),
  );
  const request = buildRequestBlock(
    askCount,
    type,
    opts.focus,
    // Naming refused titles up front is cheaper than filtering them afterwards:
    // every suppressed suggestion that still comes back costs a TMDB lookup.
    mergeExcludeNames(
      [
        ...(opts.exclude ?? []),
        ...existing.filter((title) => title.deletedAt !== null).map((title) => title.name),
      ],
      suppressed.recentNames,
    ),
    opts.language,
    opts.genre,
    opts.era,
  );

  // Dedup / ownership context shared by every suggestion in this run. Trashed
  // titles remain owned identities: they stay out of the taste signal but join
  // both TMDB and name/year exclusion sets so Claude cannot recommend them back.
  const ctx: StreamContext = {
    existingSet: new Set(
      existing
        .filter((title) => title.tmdbId !== null)
        .map((title) => `${title.mediaType}:${title.tmdbId}`),
    ),
    libNameYear: new Set([
      ...rows.map((r) => nameYearKey(r.mediaType, r.name, r.year)),
      ...existing
        .filter((title) => title.deletedAt !== null)
        .map((title) =>
          nameYearKey(
            title.mediaType === MediaType.TV ? "tv" : "movie",
            title.name,
            title.releaseDate?.getUTCFullYear() ?? null,
          ),
        ),
    ]),
    excludeSet: new Set((opts.exclude ?? []).map((t) => norm(t))),
    seenKeys: new Set(),
    resolvedKeys: new Set(),
    suppressed,
    requirements,
    tallies: { filteredOut: 0, lookupFailed: 0 },
  };

  if (runSignal.aborted) return;
  let sharedReservationDay: string | null = null;
  const releaseUnusedSharedSlot = () => {
    const day = sharedReservationDay;
    if (!day) return;
    sharedReservationDay = null;
    void releaseSharedAiRun(day).catch((error) => {
      console.error("Could not release an unused shared AI allowance slot:", error);
    });
  };
  try {
    if (usedFallback) {
      const reservation = await reserveSharedAiRun();
      if (!reservation.allowed) {
        emit({ type: "error", error: SHARED_AI_LIMIT_REACHED });
        return;
      }
      sharedReservationDay = reservation.day;
    }
  } catch (error) {
    console.error("Could not reserve the shared AI daily allowance:", error);
    emit({
      type: "error",
      error:
        "The shared AI allowance couldn't be checked. Add a personal Anthropic API key in Settings, or try again later.",
    });
    return;
  }
  if (runSignal.aborted) {
    releaseUnusedSharedSlot();
    return;
  }

  const client = anthropicClient(key);
  // The beta namespace, because `fallbacks` is a beta parameter. It is the
  // same endpoint, and a request without beta headers behaves as it would on
  // client.messages.
  const stream = client.beta.messages.stream(buildRecRequest(model, askCount, brief, request));
  if (signal) {
    // Client went away (or asked to stop): stop paying for generation. Guard the
    // race where the signal fired between the last checkpoint and here — a fresh
    // "abort" would never fire on an already-aborted signal, so abort directly.
    if (runSignal.aborted) stream.abort();
    else runSignal.addEventListener("abort", () => stream.abort(), { once: true });
  }

  const extractor = createRecExtractor();
  let accepted = 0;
  let statusSent: "thinking" | "generating" | null = null;
  let lastHeartbeatAt: number | null = null;
  let stopped = false; // no further emits once set (enough results, or a failure)
  let hitMaxTokens = false; // model ran into the output ceiling (budget exhausted)
  let hitRefusal = false; // safety classifier declined the request (HTTP 200, not a thrown error)
  let sawMessageStart = false;
  // Prompt-cache counters, read off the opening usage. They are settled by
  // message_start, so they survive the abort we fire once enough suggestions
  // land — which is the normal path, and one that leaves no final message.
  let cacheCreated: number | null = null;
  let cacheRead: number | null = null;
  // The model that served the opening usage, and the one producing output
  // now. With the server-side fallback neither has to be `model`: a decline
  // before any output, or sticky routing after an earlier one, opens on the
  // fallback model, and a mid-stream decline switches at a fallback block.
  let cacheModel: string = model;
  let servedModel: string = model;
  // A bounded queue preserves burst candidates until rejected matches release
  // capacity. Five active lookups remain the concurrency ceiling.
  const pending: Recommendation[] = [];
  const enrichments = new Set<Promise<void>>();
  let inFlight = 0;
  let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleKeepAlive = () => {
    keepAliveTimer = setTimeout(() => {
      if (stopped || runSignal.aborted) return;
      emit({ type: "status", phase: statusSent === "generating" ? "generating" : "thinking" });
      scheduleKeepAlive();
    }, RECOMMEND_KEEPALIVE_MS);
  };

  const stopKeepAlive = () => {
    if (keepAliveTimer !== null) clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
  };

  const pump = () => {
    while (
      !stopped &&
      !runSignal.aborted &&
      accepted + inFlight < count &&
      inFlight < 5 &&
      pending.length > 0
    ) {
      const rec = pending.shift()!;
      inFlight += 1;
      const task = (async () => {
        const enriched = await enrichRec(rec, ctx, searchByType, runSignal);
        if (!enriched || stopped || runSignal.aborted) return;
        accepted += 1;
        emit({ type: "rec", rec: enriched });
        if (accepted >= count) {
          stopped = true;
          pending.length = 0;
          stopController.abort();
          stream.abort();
        }
      })().finally(() => {
        inFlight -= 1;
        enrichments.delete(task);
        pump();
      });
      enrichments.add(task);
    }
  };

  const settleEnrichments = async () => {
    pump();
    while (enrichments.size > 0) {
      await Promise.allSettled([...enrichments]);
      pump();
    }
  };

  const handleParsed = (raw: unknown) => {
    if (stopped || runSignal.aborted || accepted >= count) return;
    if (!isValidRec(raw)) return;
    const rec = raw as Recommendation;
    // Near-duplicate of an earlier suggestion this run?
    const k = nameYearKey(rec.mediaType, rec.title, rec.year);
    if (ctx.seenKeys.has(k)) return;
    ctx.seenKeys.add(k);
    // Already shown this session, or already in the library by name+year?
    if (ctx.excludeSet.has(norm(rec.title))) return;
    if (ctx.libNameYear.has(k)) return;
    // Turned down in an earlier session — drop it here, before the TMDB lookup.
    if (isSuppressedByName(ctx.suppressed, rec.mediaType, rec.title, rec.year)) return;
    if (opts.type && opts.type !== "all" && rec.mediaType !== opts.type) return;

    if (pending.length >= MAX_PENDING_RECOMMENDATIONS) return;
    pending.push(rec);
    pump();
  };

  scheduleKeepAlive();
  try {
    for await (const event of stream) {
      if (event.type === "message_start") {
        sawMessageStart = true;
        cacheCreated = event.message.usage.cache_creation_input_tokens;
        cacheRead = event.message.usage.cache_read_input_tokens;
        cacheModel = servedModel = event.message.model;
        // Sticky-routed runs carry no fallback block, so this is their only trail.
        if (servedModel !== model) {
          console.warn(`Recommendation served by ${servedModel} instead of ${model}.`);
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "thinking" && statusSent === null) {
          statusSent = "thinking";
          lastHeartbeatAt = Date.now();
          emit({ type: "status", phase: "thinking" });
        } else if (event.content_block.type === "fallback") {
          // The requested model declined and another took over on this
          // stream; otherwise invisible, so leave a trail like the cache one.
          servedModel = event.content_block.to.model;
          console.warn(
            `Recommendation fell back from ${event.content_block.from.model} to ${event.content_block.to.model}.`,
          );
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "thinking_delta" && statusSent !== "generating") {
          const now = Date.now();
          if (shouldSendThinkingHeartbeat(lastHeartbeatAt, now)) {
            statusSent = "thinking";
            lastHeartbeatAt = now;
            emit({ type: "status", phase: "thinking" });
          }
        } else if (event.delta.type === "text_delta") {
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
        // Opus 5.5's safety classifiers can decline with a normal HTTP 200 rather
        // than a thrown error — same event, stop_reason "refusal" instead of an
        // exception, so it's detected here rather than in the catch block below.
        // stop_details is informational only (it can be null on a refusal), so
        // it goes to the log, never into the branch.
        else if (event.delta.stop_reason === "refusal") {
          hitRefusal = true;
          console.warn(
            `Recommendation declined by ${servedModel} (category: ${event.delta.stop_details?.category ?? "none"}).`,
          );
        }
      }
    }
  } catch (e) {
    // An abort we triggered (enough results) or the client triggered is not an
    // error; anything else gets a friendly explanation. Partial results already
    // emitted stay valid — the client keeps them alongside the error.
    if (!stopped && !runSignal.aborted) {
      stopped = true;
      stopController.abort();
      await settleEnrichments();
      stopKeepAlive();
      if (!sawMessageStart) releaseUnusedSharedSlot();
      console.error("Recommendation request failed:", e);
      emit({ type: "error", error: friendlyAnthropicError(e) });
      return;
    }
  }

  await settleEnrichments();
  stopKeepAlive();
  if (!sawMessageStart) releaseUnusedSharedSlot();
  // Whether the breakpoint actually cached is otherwise invisible — a prefix
  // under the model's minimum is ignored without any error — so leave a trail.
  if (cacheCreated !== null || cacheRead !== null) {
    console.debug(
      `Recommend prompt cache (${cacheModel}): written=${cacheCreated ?? 0}, read=${cacheRead ?? 0}`,
    );
  }
  for (const e of terminalRecEvents(accepted, count, {
    hitMaxTokens,
    hitRefusal,
    aborted: signal?.aborted ?? false,
    filteredOut: ctx.tallies?.filteredOut ?? 0,
    lookupFailed: ctx.tallies?.lookupFailed ?? 0,
  })) {
    emit(e);
  }
}
