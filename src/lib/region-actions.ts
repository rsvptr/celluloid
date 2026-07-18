"use server";

import { cookies } from "next/headers";
import { requireUserId } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { isWatchRegion } from "@/lib/tmdb-extras";

const COOKIE = "celluloid-region";

export async function setWatchRegion(region: string): Promise<void> {
  await requireUserId(); // no anonymous writes
  if (!isWatchRegion(region)) return;
  (await cookies()).set(COOKIE, region, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}

/**
 * Persists the chosen region as the user's profile default so it carries
 * over to new devices and sessions after the cookie is gone. Called
 * fire-and-forget from the region picker — the cookie above is the fast
 * cache the title page actually reads from, so this write never blocks it.
 */
export async function saveWatchRegionPreference(region: string): Promise<void> {
  const userId = await requireUserId();
  if (!isWatchRegion(region)) return;
  await prisma.user.update({
    where: { id: userId },
    data: { watchRegion: region },
  });
}
