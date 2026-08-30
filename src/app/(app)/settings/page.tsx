import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAccountInfo, getUserPrefs, getUserShareLists } from "@/lib/data";
import { getWatchProviders } from "@/lib/tmdb";
import { DEFAULT_WATCH_REGION } from "@/lib/tmdb-extras";
import { MetadataSyncState } from "@/generated/prisma/client";
import {
  isRememberFiltersEnabled,
  REMEMBER_FILTERS_TOGGLE_COOKIE,
} from "@/lib/remembered-state";
import {
  SettingsClient,
  type MetadataFailureSummary,
  type ProviderOption,
  type TagSummary,
} from "./settings-client";

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
  const preferencesPromise = getUserPrefs(user.id);
  // The catalogue depends only on the saved account region. Start every other
  // independent read before resolving that dependency so Settings does not add
  // an avoidable database/API waterfall.
  const providerCataloguePromise = preferencesPromise.then(async (prefs) => {
    const region = prefs?.watchRegion ?? DEFAULT_WATCH_REGION;
    try {
      const providers = await getWatchProviders(region);
      return {
        unavailable: false,
        providers: providers.map(
          (provider): ProviderOption => ({
            id: provider.provider_id,
            name: provider.provider_name,
            logoPath: provider.logo_path,
          }),
        ),
      };
    } catch (error) {
      console.error(`Could not load TMDB watch providers for ${region}:`, error);
      return { unavailable: true, providers: [] as ProviderOption[] };
    }
  });
  const metadataFailuresPromise = prisma.title.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      metadataSyncState: MetadataSyncState.FAILED,
    },
    orderBy: [{ metadataSyncedAt: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      mediaType: true,
      metadataLastError: true,
    },
  });

  const [info, shares, tags, prefs, providerCatalogue, cookieStore, metadataFailures] =
    await Promise.all([
      getAccountInfo(user.id),
      getUserShareLists(user.id),
      getTagSummaries(user.id),
      preferencesPromise,
      providerCataloguePromise,
      cookies(),
      metadataFailuresPromise,
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
        myProviders={prefs?.myProviders ?? []}
        providers={providerCatalogue.providers}
        providersUnavailable={providerCatalogue.unavailable}
        metadataFailures={metadataFailures satisfies MetadataFailureSummary[]}
        lastBackupAt={prefs?.lastBackupAt?.toISOString() ?? null}
        backupAgeDays={backupAgeInDays(prefs?.lastBackupAt)}
        rememberFilters={isRememberFiltersEnabled(
          cookieStore.get(REMEMBER_FILTERS_TOGGLE_COOKIE)?.value,
        )}
      />
    </div>
  );
}
