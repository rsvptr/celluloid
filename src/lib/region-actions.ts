"use server";

import { cookies } from "next/headers";
import { requireUserId } from "@/lib/session";
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
