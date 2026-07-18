import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAccountInfo, getUserShareLists } from "@/lib/data";
import { DEFAULT_WATCH_REGION } from "@/lib/tmdb-extras";
import { SettingsClient } from "./settings-client";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();
  const [info, shares, prefs] = await Promise.all([
    getAccountInfo(user.id),
    getUserShareLists(user.id),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { timeZone: true, watchRegion: true },
    }),
  ]);
  return (
    // Full shell width (D-UI-17 amendment): no per-page cap.
    <div>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>
      <SettingsClient
        info={info}
        shares={shares}
        timeZone={prefs?.timeZone ?? "UTC"}
        watchRegion={prefs?.watchRegion ?? DEFAULT_WATCH_REGION}
      />
    </div>
  );
}
