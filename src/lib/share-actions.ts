"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

/** ~12 url-safe characters of entropy — unguessable. */
function makeSlug(): string {
  return randomBytes(9).toString("base64url");
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

const createShareInputSchema = z.object({
  titleIds: z.array(shareIdSchema).optional(),
  name: z.string().max(200).nullable().optional(),
  includeNotes: z.boolean().optional(),
  includeWatchlist: z.boolean().optional(),
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]).optional(),
}).strict();
const deleteShareSchema = z.object({ id: shareIdSchema });

export async function createShareList(
  input: CreateShareInput,
): Promise<{ slug?: string; error?: string }> {
  const userId = await requireUserId();
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
          titleIds,
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
  const userId = await requireUserId();
  const parsed = deleteShareSchema.safeParse({ id });
  if (!parsed.success) return { ok: false };
  const deleted = await prisma.shareList.deleteMany({ where: { id, userId } });
  revalidatePath("/settings");
  return { ok: deleted.count > 0 };
}

export async function revokeShareList(id: string): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  const parsed = deleteShareSchema.safeParse({ id });
  if (!parsed.success) return { ok: false };
  const revoked = await prisma.shareList.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  revalidatePath("/settings");
  return { ok: revoked.count > 0 };
}
