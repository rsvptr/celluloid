import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAccountInfo, getUserShareLists } from "@/lib/data";
import { DEFAULT_WATCH_REGION } from "@/lib/tmdb-extras";
import { SettingsClient, type TagSummary } from "./settings-client";

export const metadata: Metadata = { title: "Settings" };

/**
 * Tags with the number of titles each one is actually on. The count is read
 * from TitleTag joined against live titles rather than a plain relation count,
 * so a tag left over on trashed titles reads as "0 titles" — deleting a tag has
 * to state what it will detach, and trashed titles are not part of the library.
 */
async function getTagSummaries(userId: string): Promise<TagSummary[]> {
  const [tags, counts] = await Promise.all([
    prisma.tag.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
    prisma.titleTag.groupBy({
      by: ["tagId"],
      where: { title: { userId, deletedAt: null } },
      _count: { titleId: true },
    }),
  ]);
  const byTag = new Map(counts.map((row) => [row.tagId, row._count.titleId]));
  return tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    count: byTag.get(tag.id) ?? 0,
  }));
}

/** Whole days since `at`, or null when there has never been a backup. */
function backupAgeInDays(at: Date | null | undefined): number | null {
  if (!at) return null;
  return Math.floor((Date.now() - at.getTime()) / 86_400_000);
}

export default async function SettingsPage() {
  const user = await requireUser();
  const [info, shares, tags, prefs] = await Promise.all([
    getAccountInfo(user.id),
    getUserShareLists(user.id),
    getTagSummaries(user.id),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { timeZone: true, watchRegion: true, lastBackupAt: true },
    }),
  ]);
  return (
    // Full shell width (D-UI-17 amendment): no per-page cap.
    <div>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>
      <SettingsClient
        info={info}
        shares={shares}
        tags={tags}
        timeZone={prefs?.timeZone ?? "UTC"}
        watchRegion={prefs?.watchRegion ?? DEFAULT_WATCH_REGION}
        lastBackupAt={prefs?.lastBackupAt?.toISOString() ?? null}
        backupAgeDays={backupAgeInDays(prefs?.lastBackupAt)}
      />
    </div>
  );
}
