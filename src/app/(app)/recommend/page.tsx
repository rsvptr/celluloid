import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAccountInfo, getLibraryFacets, getTags } from "@/lib/data";
import { DEFAULT_REC_MODEL } from "@/lib/models";
import { RecommendClient } from "./recommend-client";

export const metadata: Metadata = { title: "Recommend" };

export default async function RecommendPage() {
  const user = await requireUser();
  const [info, tags, facets, watchedCount] = await Promise.all([
    getAccountInfo(user.id),
    getTags(user.id),
    getLibraryFacets(user.id),
    prisma.title.count({
      where: { userId: user.id, watchedAt: { not: null }, deletedAt: null },
    }),
  ]);
  return (
    // Full shell width (D-UI-17 amendment): no per-page cap.
    <div>
      <RecommendClient
        hasKey={info.hasApiKey || info.hasServerKey}
        model={info.recommendModel ?? DEFAULT_REC_MODEL}
        tags={tags.map((t) => t.name)}
        languages={facets.languages}
        genres={facets.genres}
        hasWatchDates={watchedCount > 0}
      />
    </div>
  );
}
