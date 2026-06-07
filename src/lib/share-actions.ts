"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/session";
import { prisma } from "@/lib/prisma";

/** ~12 url-safe characters of entropy — unguessable. */
function makeSlug(): string {
  return randomBytes(9).toString("base64url");
}

export interface CreateShareInput {
  titleIds?: string[]; // empty/omitted = whole library (live)
  name?: string | null;
  includeNotes?: boolean;
  includeWatchlist?: boolean; // only relevant for whole-library shares
}

export async function createShareList(
  input: CreateShareInput,
): Promise<{ slug?: string; error?: string }> {
  const userId = await requireUserId();

  // Only ever store ids the user actually owns.
  let titleIds: string[] = [];
  if (input.titleIds && input.titleIds.length > 0) {
    const owned = await prisma.title.findMany({
      where: { id: { in: input.titleIds }, userId },
      select: { id: true },
    });
    titleIds = owned.map((o) => o.id);
    if (titleIds.length === 0) return { error: "Nothing to share." };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = makeSlug();
    const clash = await prisma.shareList.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (clash) continue;
    await prisma.shareList.create({
      data: {
        slug,
        userId,
        name: input.name?.trim() || null,
        titleIds,
        includeNotes: !!input.includeNotes,
        includeWatchlist: !!input.includeWatchlist,
      },
    });
    revalidatePath("/settings");
    return { slug };
  }
  return { error: "Couldn't generate a unique link. Please try again." };
}

export async function deleteShareList(id: string): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  await prisma.shareList.deleteMany({ where: { id, userId } });
  revalidatePath("/settings");
  return { ok: true };
}
