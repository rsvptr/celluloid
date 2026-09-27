import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { Poster } from "@/components/poster";
import { Badge } from "@/components/ui";
import { STATUS_META, airedAgoText, progressPct, tvStatusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getUpcoming, type AiringSoonEntry, type WaitingEntry } from "./data";

export const metadata: Metadata = { title: "Airing soon" };

const DAY_MS = 86_400_000;

/** Row list container — same treatment as the library's list view. */
const listClass =
  "flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-card)] ring-1 ring-line";

function addDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(fromKey: string, toKey: string): number {
  return Math.round(
    (Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * "Today" / "Tomorrow" / "Sat, Aug 2". Formatted in UTC because the key is a
 * calendar date rather than an instant — rendering it in a viewer's zone would
 * shift a midnight-anchored date onto the wrong day.
 */
function dayLabel(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return "Today";
  if (dateKey === addDays(todayKey, 1)) return "Tomorrow";
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    // Only worth the extra width once the schedule crosses into another year.
    year: dateKey.slice(0, 4) === todayKey.slice(0, 4) ? undefined : "numeric",
    timeZone: "UTC",
  });
}

function relativeDays(dateKey: string, todayKey: string): string {
  const days = daysBetween(todayKey, dateKey);
  if (days <= 1) return "";
  return days === 7 ? "in a week" : `in ${days} days`;
}

function TitleRow({
  id,
  name,
  posterPath,
  meta,
  trailing,
}: {
  id: string;
  name: string;
  posterPath: string | null;
  meta: string;
  trailing: React.ReactNode;
}) {
  return (
    <Link
      href={`/title/${id}`}
      className="focus-ring flex min-h-11 items-center gap-3 bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2/50"
    >
      <div className="w-9 shrink-0">
        <Poster
          path={posterPath}
          name={name}
          decorative
          mediaType="TV"
          size="w92"
          sizes="36px"
        />
      </div>
      <div className="min-w-0 flex-1">
        {/* title: a truncated line keeps its full text in reach (JK-27). */}
        <div className="truncate text-sm font-medium" title={name}>
          {name}
        </div>
        <div className="truncate text-xs text-muted" title={meta}>
          {meta}
        </div>
      </div>
      {trailing}
    </Link>
  );
}

function progressText(entry: {
  totalEpisodes: number | null;
  watchedEpisodes: number;
}): string {
  if (!entry.totalEpisodes) return "";
  return `${entry.watchedEpisodes}/${entry.totalEpisodes} eps (${progressPct(
    entry.watchedEpisodes,
    entry.totalEpisodes,
  )}%)`;
}

function AiringRow({ entry }: { entry: AiringSoonEntry }) {
  const status = STATUS_META[entry.status];
  const meta = [entry.tmdbStatus && tvStatusLabel(entry.tmdbStatus), progressText(entry)]
    .filter(Boolean)
    .join(" · ");
  return (
    <TitleRow
      id={entry.id}
      name={entry.name}
      posterPath={entry.posterPath}
      meta={meta || "TV"}
      trailing={
        <Badge className={status.badge}>
          <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
          {status.label}
        </Badge>
      }
    />
  );
}

function WaitingRow({ entry, todayKey }: { entry: WaitingEntry; todayKey: string }) {
  const meta = [`latest ${airedAgoText(entry.latestAirDateKey, todayKey)}`, progressText(entry)]
    .filter(Boolean)
    .join(" · ");
  return (
    <TitleRow
      id={entry.id}
      name={entry.name}
      posterPath={entry.posterPath}
      meta={meta}
      trailing={
        <Badge className="bg-brand/15 text-brand ring-brand/30">
          {entry.waiting} to watch
        </Badge>
      }
    />
  );
}

/**
 * Why the page can be empty matters more than the fact that it is. Until the
 * scheduled sync has run at least once, every air date in the database is
 * whatever TMDB said on the day each title was added — which for most libraries
 * is nothing at all — so an unexplained empty page reads as a broken feature
 * rather than a pending one.
 */
function EmptyState({
  trackedShows,
  lastSyncedAt,
}: {
  trackedShows: number;
  lastSyncedAt: string | null;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line px-6 py-20 text-center">
      {trackedShows === 0 ? (
        <>
          <p className="text-sm text-muted">
            You aren&apos;t tracking any TV shows yet.
          </p>
          <Link
            href="/add"
            className="focus-ring inline-flex min-h-11 items-center rounded text-sm font-medium text-brand hover:underline sm:min-h-0"
          >
            Add a show
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">Nothing scheduled right now.</p>
          <p className="max-w-md text-sm text-faint">
            {lastSyncedAt
              ? "Celluloid checks TMDB once a day for new episodes of the shows you track. Air dates appear here as soon as TMDB publishes them."
              : "Celluloid checks TMDB once a day for new episodes of the shows you track. This page fills in after that check runs for the first time."}
          </p>
        </>
      )}
    </div>
  );
}

export default async function UpcomingPage() {
  const user = await requireUser();
  const { todayKey, groups, waiting, trackedShows, lastSyncedAt } = await getUpcoming(
    user.id,
  );
  const isEmpty = groups.length === 0 && waiting.length === 0;

  return (
    // Full shell width (D-UI-17 amendment): no per-page cap.
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Airing soon</h1>
        <p className="mt-1 text-sm text-muted">
          Scheduled episodes of the shows you track, and what has aired since you
          last watched.
        </p>
      </div>

      {isEmpty ? (
        <EmptyState trackedShows={trackedShows} lastSyncedAt={lastSyncedAt} />
      ) : (
        <>
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold">Coming up</h2>
            {/* Only "Waiting for you" has rows: say so, rather than leave
                the reader wondering whether the schedule failed (JK-31). */}
            {groups.length === 0 && (
              <p className="text-xs text-muted">
                No new episodes are scheduled for the shows you track.
              </p>
            )}
            {groups.map((group) => {
              const relative = relativeDays(group.dateKey, todayKey);
              return (
                <div key={group.dateKey} className="flex flex-col gap-2">
                  <h3 className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-faint">
                    {dayLabel(group.dateKey, todayKey)}
                    {relative && (
                      <span className="font-normal normal-case tracking-normal">
                        {relative}
                      </span>
                    )}
                  </h3>
                  <div className={listClass}>
                    {group.entries.map((entry) => (
                      <AiringRow key={entry.id} entry={entry} />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>

          {waiting.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">Waiting for you</h2>
              <p className="text-xs text-muted">
                Episodes that have already aired and are still unwatched.
              </p>
              <div className={cn(listClass, "mt-1")}>
                {waiting.map((entry) => (
                  <WaitingRow key={entry.id} entry={entry} todayKey={todayKey} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
