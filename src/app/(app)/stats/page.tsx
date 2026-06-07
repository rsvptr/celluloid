import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { getStats } from "@/lib/data";
import { StatsClient } from "./stats-client";

export const metadata: Metadata = { title: "Stats" };

export default async function StatsPage() {
  const user = await requireUser();
  const stats = await getStats(user.id);

  if (stats.total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <p className="text-sm text-muted">No stats yet. Add a few titles first.</p>
        <Link href="/add" className="focus-ring rounded text-sm font-medium text-brand hover:underline">
          Add a title →
        </Link>
      </div>
    );
  }

  return <StatsClient stats={stats} />;
}
