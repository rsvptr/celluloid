import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAccountInfo, getLibraryFacets, getTags } from "@/lib/data";
import { resolveRecModel } from "@/lib/models";
import {
  isRememberFiltersEnabled,
  parseRecommendRememberedState,
  REMEMBERED_COOKIE_NAMES,
  REMEMBER_FILTERS_TOGGLE_COOKIE,
} from "@/lib/remembered-state";
import { RecommendClient } from "./recommend-client";

export const metadata: Metadata = { title: "Recommend" };

export default async function RecommendPage() {
  const user = await requireUser();
  const [info, tags, facets, watchedCount, cookieStore] = await Promise.all([
    getAccountInfo(user.id),
    getTags(user.id),
    getLibraryFacets(user.id),
    prisma.title.count({
      where: { userId: user.id, watchedAt: { not: null }, deletedAt: null },
    }),
    cookies(),
  ]);
  const rememberFilters = isRememberFiltersEnabled(
    cookieStore.get(REMEMBER_FILTERS_TOGGLE_COOKIE)?.value,
  );
  const initialPreferences = rememberFilters
    ? parseRecommendRememberedState(
        cookieStore.get(REMEMBERED_COOKIE_NAMES.recommend)?.value,
      )
    : null;
  return (
    // Full shell width (D-UI-17 amendment): no per-page cap.
    <div>
      <RecommendClient
        hasKey={info.hasApiKey || info.hasServerKey}
        keySource={info.hasApiKey ? "personal" : info.hasServerKey ? "shared" : "none"}
        model={resolveRecModel(info.recommendModel)}
        tags={tags.map((t) => t.name)}
        languages={facets.languages}
        genres={facets.genres}
        hasWatchDates={watchedCount > 0}
        initialPreferences={initialPreferences}
        rememberFilters={rememberFilters}
      />
    </div>
  );
}
