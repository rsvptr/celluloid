import { prisma } from "@/lib/prisma";
import { WatchEventKind } from "@/generated/prisma/client";
import { WatchHistoryList, type WatchEventVM } from "./watch-history-client";

/**
 * D-F9: a quiet log of past viewings for a title, surfacing the note captured
 * on "Log a watch" (e.g. "Watched with Dad") that was previously stored on
 * WatchEvent.note but never rendered anywhere. Scoped to
 * TITLE_COMPLETED/REWATCH only — episode-level events belong to the season
 * tracker, not this list.
 *
 * `total` is the caller's already-fetched TITLE_COMPLETED+REWATCH count
 * (page.tsx needs the same number in parallel for the "Watched n times"
 * badge / TitleControls), reused here for the "n watches total" footer
 * instead of issuing a second COUNT query.
 */
export async function WatchHistory({
  userId,
  titleId,
  total,
}: {
  userId: string;
  titleId: string;
  total: number;
}) {
  if (total === 0) return null;

  // Scoped by userId + titleId (both indexed via @@index([titleId, occurredAt])
  // and @@index([userId, occurredAt])); lean select, capped at 6 rows.
  const events = await prisma.watchEvent.findMany({
    where: {
      userId,
      titleId,
      kind: { in: [WatchEventKind.TITLE_COMPLETED, WatchEventKind.REWATCH] },
    },
    orderBy: { occurredAt: "desc" },
    take: 6,
    select: { id: true, kind: true, occurredAt: true, note: true },
  });
  if (events.length === 0) return null;

  // Serialize to plain props for the client boundary: Date and the Prisma enum
  // don't cross it, and the date input needs the ISO string anyway.
  const items: WatchEventVM[] = events.map((e) => ({
    id: e.id,
    kind: e.kind === WatchEventKind.REWATCH ? "REWATCH" : "TITLE_COMPLETED",
    occurredAt: e.occurredAt.toISOString(),
    note: e.note,
  }));

  return <WatchHistoryList events={items} total={total} />;
}
