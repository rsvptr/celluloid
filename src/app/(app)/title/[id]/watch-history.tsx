import { prisma } from "@/lib/prisma";
import { WatchEventKind } from "@/generated/prisma/client";
import { Card } from "@/components/ui";
import { fullDate } from "@/lib/format";

function kindLabel(kind: WatchEventKind): string {
  return kind === WatchEventKind.REWATCH ? "Rewatched" : "Watched";
}

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

  return (
    <Card variant="inset" className="flex flex-col gap-3 p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-faint">
        History
      </h2>
      <ul className="flex flex-col gap-3">
        {events.map((e) => (
          <li key={e.id} className="text-sm">
            <p className="text-foreground/90">
              {fullDate(e.occurredAt)} · {kindLabel(e.kind)}
            </p>
            {e.note && <p className="mt-0.5 text-xs text-muted">{e.note}</p>}
          </li>
        ))}
      </ul>
      {total > 6 && (
        <p className="border-t border-line pt-3 text-xs text-faint">
          {total} watches total
        </p>
      )}
    </Card>
  );
}
