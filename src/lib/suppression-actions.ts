"use server";

import { requireUserId } from "@/lib/session";
import { prisma } from "@/lib/prisma";
// Prisma is imported as a value, not a type: PrismaClientKnownRequestError is
// referenced at runtime to catch the unique-constraint race in suppress().
import { MediaType, Prisma, SuppressionReason } from "@/generated/prisma/client";
import { suppressionMatchKey } from "@/lib/recommend";
import { z } from "zod";

/** A suggestion the owner turned down, as the review UI reads it. */
export interface SuppressionEntry {
  id: string;
  name: string;
  year: number | null;
  mediaType: "movie" | "tv";
  tmdbId: number | null;
  reason: "NOT_INTERESTED" | "SEEN_ELSEWHERE";
  /** ISO-8601, so the value survives the server-action boundary unambiguously. */
  createdAt: string;
}

export interface SuppressInput {
  /** TMDB id when the suggestion resolved to one; null/omitted otherwise. */
  tmdbId?: number | null;
  mediaType: "movie" | "tv";
  name: string;
  year?: number | null;
  reason?: "NOT_INTERESTED" | "SEEN_ELSEWHERE";
}

// --- Runtime validation (SEC-04) -------------------------------------------
// These are public HTTP endpoints, so arguments are validated before any DB
// work. Failures reuse each action's return shape ({ error } for suppress,
// { ok: false } for unsuppress) rather than throwing.

const suppressInputSchema = z
  .object({
    tmdbId: z.number().int().positive().nullable().optional(),
    mediaType: z.enum(["movie", "tv"]),
    // Matches the recommendation stream's own title bound, so anything the
    // recommend page can show can also be suppressed.
    name: z.string().trim().min(1).max(200),
    year: z.number().int().min(1800).max(2200).nullable().optional(),
    reason: z.enum(["NOT_INTERESTED", "SEEN_ELSEWHERE"]).optional(),
  })
  .strict();

const suppressionIdSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * Ceiling on rows returned to the review UI. The list only grows, and the newest
 * refusals are the ones an owner is likely to want back; an unbounded read here
 * would eventually ship the whole table to the browser for no benefit.
 */
const MAX_LISTED = 500;

function toEntryMediaType(mediaType: MediaType): "movie" | "tv" {
  return mediaType === MediaType.TV ? "tv" : "movie";
}

/**
 * Record that the owner does not want to see this suggestion again. Rejections
 * used to live only in the recommend page's component state, so they died on
 * reload and a refused title came straight back on the next run; this is the
 * durable half of that, sitting under the in-session "already shown" list rather
 * than replacing it.
 */
export async function suppressSuggestion(
  input: SuppressInput,
): Promise<{ id?: string; error?: string }> {
  const userId = await requireUserId();
  const parsed = suppressInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const data = parsed.data;

  const name = data.name.trim();
  const matchKey = suppressionMatchKey({
    mediaType: data.mediaType,
    tmdbId: data.tmdbId,
    name,
    year: data.year,
  });
  const row = {
    userId,
    matchKey,
    tmdbId: data.tmdbId ?? null,
    mediaType: data.mediaType === "tv" ? MediaType.TV : MediaType.MOVIE,
    name,
    year: data.year ?? null,
    reason:
      data.reason === "SEEN_ELSEWHERE"
        ? SuppressionReason.SEEN_ELSEWHERE
        : SuppressionReason.NOT_INTERESTED,
  };

  try {
    const created = await prisma.suppression.create({ data: row, select: { id: true } });
    return { id: created.id };
  } catch (err) {
    // Two dismissals of the same title (a double-tap, or the same title
    // suggested in two open tabs) race the @@unique([userId, matchKey]). The
    // owner's intent is already recorded, so return the existing row instead of
    // an error the UI would have to explain.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.suppression.findUnique({
        where: { userId_matchKey: { userId, matchKey } },
        select: { id: true },
      });
      if (existing) return { id: existing.id };
    }
    console.error(`suppressSuggestion failed (matchKey=${matchKey}):`, err);
    // Never surface the raw error: it can carry ORM internals.
    return { error: "Couldn't hide that suggestion. Please try again." };
  }
}

/** Undo a suppression, so the title can be recommended again. */
export async function unsuppressSuggestion(id: string): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  const parsed = suppressionIdSchema.safeParse({ id });
  if (!parsed.success) return { ok: false };
  const deleted = await prisma.suppression.deleteMany({ where: { id, userId } });
  return { ok: deleted.count > 0 };
}

/**
 * The owner's "not interested" list, newest first. Read on demand by the review
 * panel — nothing server-rendered depends on it, so no path needs revalidating
 * when the list changes.
 */
export async function listSuppressions(): Promise<SuppressionEntry[]> {
  const userId = await requireUserId();
  const rows = await prisma.suppression.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: MAX_LISTED,
    select: {
      id: true,
      name: true,
      year: true,
      mediaType: true,
      tmdbId: true,
      reason: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    year: row.year,
    mediaType: toEntryMediaType(row.mediaType),
    tmdbId: row.tmdbId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));
}
