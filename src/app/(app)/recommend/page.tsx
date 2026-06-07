import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getAccountInfo, getTags } from "@/lib/data";
import { DEFAULT_REC_MODEL } from "@/lib/models";
import { RecommendClient } from "./recommend-client";

export const metadata: Metadata = { title: "Recommend" };

export default async function RecommendPage() {
  const user = await requireUser();
  const [info, tags, watchedCount] = await Promise.all([
    getAccountInfo(user.id),
    getTags(user.id),
    prisma.title.count({ where: { userId: user.id, watchedAt: { not: null } } }),
  ]);
  return (
    <div className="mx-auto max-w-3xl">
      <RecommendClient
        hasKey={info.hasApiKey || info.hasServerKey}
        model={info.recommendModel ?? DEFAULT_REC_MODEL}
        tags={tags.map((t) => t.name)}
        hasWatchDates={watchedCount > 0}
      />
    </div>
  );
}
