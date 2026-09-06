"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { orderSharedTitles, shareTitleVisibility } from "@/lib/data";
import type { MediaType, WatchStatus } from "@/generated/prisma/client";
import { z } from "zod";

/** ~12 url-safe characters of entropy — unguessable. */
function makeSlug(): string {
  return randomBytes(9).toString("base64url");
}

const SIGNED_OUT_MESSAGE = "You're signed out. Sign in and try again.";

/** Returns the signed-in user's id, or null instead of throwing (see AUD-45). */
async function getUserId(): Promise<string | null> {
  const session = await getSession();
  return session?.user?.id ?? null;
}

export interface CreateShareInput {
  titleIds?: string[]; // empty/omitted = whole library (live)
  name?: string | null;
  includeNotes?: boolean;
  includeWatchlist?: boolean; // only relevant for whole-library shares
  expiresInDays?: 7 | 30 | 90 | null;
}

// --- Runtime validation (SEC-04) -------------------------------------------
// These server actions are public HTTP endpoints, so validate arguments before
// any database work. Failures reuse each action's existing return shape
// ({ error } for createShareList, { ok: false } for deleteShareList).

/**
 * Hard ceiling on ids stored per share, after dedup. This is a resource/DoS
 * guard, not a UX limit — the owner legitimately shares more than a couple
 * hundred titles, so exceeding it rejects the request outright (see
 * createShareList) rather than silently sharing only a truncated subset.
 */
const MAX_SHARE_IDS = 1000;
const shareIdSchema = z.string().min(1).max(64);

const expiresInDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.null(),
]);

const createShareInputSchema = z.object({
  titleIds: z.array(shareIdSchema).optional(),
  name: z.string().max(200).nullable().optional(),
  includeNotes: z.boolean().optional(),
  includeWatchlist: z.boolean().optional(),
  expiresInDays: expiresInDaysSchema.optional(),
}).strict();
const deleteShareSchema = z.object({ id: shareIdSchema });
const renameShareSchema = z.object({
  id: shareIdSchema,
  name: z.string().max(200).nullable(),
});
const shareExpirySchema = z.object({
  id: shareIdSchema,
  expiresInDays: expiresInDaysSchema,
});

export async function createShareList(
  input: CreateShareInput,
): Promise<{ slug?: string; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = createShareInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const data = parsed.data;

  // Only ever store ids the user actually owns.
  let titleIds: string[] = [];
  if (data.titleIds && data.titleIds.length > 0) {
    // Dedupe the requested selection before it reaches the query. Oversized
    // selections are rejected outright below, never silently truncated.
    const requested = [...new Set(data.titleIds)];
    if (requested.length > MAX_SHARE_IDS) {
      return { error: `Too many titles selected (max ${MAX_SHARE_IDS}).` };
    }
    const owned = await prisma.title.findMany({
      where: { id: { in: requested }, userId, deletedAt: null },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((title) => title.id));
    titleIds = requested.filter((id) => ownedIds.has(id));
    if (titleIds.length === 0) return { error: "Nothing to share." };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = makeSlug();
    const clash = await prisma.shareList.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (clash) continue;
    const scope = titleIds.length > 0 ? "SELECTION" : "WHOLE_LIBRARY";
    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1_000)
      : null;
    await prisma.$transaction(async (tx) => {
      const share = await tx.shareList.create({
        data: {
          slug,
          userId,
          // The dialog caps this at 80 too; enforce it where it counts.
          name: data.name?.trim().slice(0, 80) || null,
          includeNotes: !!data.includeNotes,
          includeWatchlist: scope === "WHOLE_LIBRARY" && !!data.includeWatchlist,
          scope,
          expiresAt,
        },
        select: { id: true },
      });
      if (titleIds.length > 0) {
        await tx.shareListItem.createMany({
          data: titleIds.map((titleId, index) => ({
            shareListId: share.id,
            titleId,
            position: index + 1,
          })),
        });
      }
    });
    revalidatePath("/settings");
    return { slug };
  }
  return { error: "Couldn't generate a unique link. Please try again." };
}

export async function deleteShareList(id: string): Promise<{ ok: boolean }> {
  const userId = await getUserId();
  if (!userId) return { ok: false };
  const parsed = deleteShareSchema.safeParse({ id });
  if (!parsed.success) return { ok: false };
  const deleted = await prisma.shareList.deleteMany({ where: { id, userId } });
  revalidatePath("/settings");
  return { ok: deleted.count > 0 };
}

export async function revokeShareList(id: string): Promise<{ ok: boolean }> {
  const userId = await getUserId();
  if (!userId) return { ok: false };
  const parsed = deleteShareSchema.safeParse({ id });
  if (!parsed.success) return { ok: false };
  const revoked = await prisma.shareList.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  revalidatePath("/settings");
  return { ok: revoked.count > 0 };
}

/**
 * Undo a revoke. The inverse of revokeShareList, and scoped just as narrowly:
 * only a share that is currently revoked is touched, so a double-click can't
 * "restore" a link that was never revoked and report success for a no-op.
 *
 * A restored link keeps its original slug — the whole point is to put back a
 * URL that was shared by hand and then revoked in haste. When that isn't what
 * the owner wants, deleting the share is still the permanent option.
 */
export async function restoreShareList(id: string): Promise<{ ok: boolean }> {
  const userId = await getUserId();
  if (!userId) return { ok: false };
  const parsed = deleteShareSchema.safeParse({ id });
  if (!parsed.success) return { ok: false };
  const restored = await prisma.shareList.updateMany({
    where: { id: parsed.data.id, userId, revokedAt: { not: null } },
    data: { revokedAt: null },
  });
  revalidatePath("/settings");
  return { ok: restored.count > 0 };
}

/** Rename a share, or clear its name back to untitled with null/"". */
export async function renameShareList(
  id: string,
  name: string | null,
): Promise<{ ok: boolean }> {
  const userId = await getUserId();
  if (!userId) return { ok: false };
  const parsed = renameShareSchema.safeParse({ id, name });
  if (!parsed.success) return { ok: false };
  const renamed = await prisma.shareList.updateMany({
    where: { id: parsed.data.id, userId },
    // Same 80-char cap createShareList enforces, so a rename can't smuggle in a
    // longer name than the create path allows.
    data: { name: parsed.data.name?.trim().slice(0, 80) || null },
  });
  revalidatePath("/settings");
  return { ok: renamed.count > 0 };
}

/**
 * Extend a share's expiry to n days from now, or clear it with null so the link
 * never expires. Measured from now rather than from the existing expiry so an
 * already-expired link comes back to life on the same choice that extends a live
 * one — the alternative silently leaves an expired link expired.
 */
export async function setShareExpiry(
  id: string,
  expiresInDays: 7 | 30 | 90 | null,
): Promise<{ ok: boolean }> {
  const userId = await getUserId();
  if (!userId) return { ok: false };
  const parsed = shareExpirySchema.safeParse({ id, expiresInDays });
  if (!parsed.success) return { ok: false };
  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1_000)
    : null;
  const updated = await prisma.shareList.updateMany({
    where: { id: parsed.data.id, userId },
    data: { expiresAt },
  });
  revalidatePath("/settings");
  return { ok: updated.count > 0 };
}

/** One row of the "what does this link actually publish" audit list. */
export interface SharedTitleSummary {
  id: string;
  name: string;
  year: number | null;
  mediaType: MediaType;
  status: WatchStatus;
}

/**
 * The titles a share currently publishes, in the order its page renders them.
 *
 * Shares were write-once and opaque: once a link existed there was no way to
 * see what was behind it, so an old whole-library link quietly grew to cover
 * every title added since, and a selection link's contents could only be
 * checked by opening the public page. Auditing what you have exposed shouldn't
 * require visiting the exposure.
 *
 * Deliberately mirrors getSharePayload's visibility rules — including the
 * WATCHLIST hiding on whole-library shares — so this answers "what a visitor
 * sees", not "what the row references". Notes are never returned: the question
 * is which titles are exposed, and the answer shouldn't ship note text into a
 * settings screen that doesn't display it.
 */
export async function getShareListTitles(
  id: string,
): Promise<{ titles?: SharedTitleSummary[]; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = deleteShareSchema.safeParse({ id });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };

  const share = await prisma.shareList.findFirst({
    where: { id: parsed.data.id, userId },
    select: {
      titleIds: true,
      includeWatchlist: true,
      scope: true,
      items: { orderBy: { position: "asc" }, select: { titleId: true } },
    },
  });
  if (!share) return { error: "That link no longer exists." };

  const isWholeLibrary = share.scope === "WHOLE_LIBRARY";
  const selectedIds =
    share.items.length > 0 ? share.items.map((item) => item.titleId) : share.titleIds;
  if (!isWholeLibrary && selectedIds.length === 0) return { titles: [] };

  const found = await prisma.title.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(isWholeLibrary ? {} : { id: { in: selectedIds } }),
    },
    ...(isWholeLibrary
      ? { orderBy: [{ favorite: "desc" as const }, { name: "asc" as const }] }
      : {}),
    select: {
      id: true,
      name: true,
      mediaType: true,
      status: true,
      releaseDate: true,
      notes: true,
    },
  });
  const ordered = isWholeLibrary ? found : orderSharedTitles(found, selectedIds);

  const visibility = {
    isWholeLibrary,
    includeWatchlist: share.includeWatchlist,
    includeNotes: false,
  };
  return {
    titles: ordered.flatMap((title) =>
      shareTitleVisibility(visibility, title).visible
        ? [
            {
              id: title.id,
              name: title.name,
              year: title.releaseDate ? title.releaseDate.getUTCFullYear() : null,
              mediaType: title.mediaType,
              status: title.status,
            },
          ]
        : [],
    ),
  };
}
