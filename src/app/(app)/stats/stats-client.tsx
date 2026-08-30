import Link from "next/link";
import { Flame } from "lucide-react";
import type { ActivityDay, LibraryStats } from "@/lib/data";
import { ESTIMATED_EPISODE_MINUTES, ESTIMATED_MOVIE_MINUTES } from "@/lib/data";
import { Card } from "@/components/ui";
import { BarRow, ColumnChart, Sparkline } from "@/components/charts";
import { ActivityCalendar } from "./activity-calendar";
import { STATUS_META, STATUS_ORDER, languageName } from "@/lib/format";
import type { WatchStatus } from "@/generated/prisma/client";

export function StatsClient({
  stats,
  activityDays,
}: {
  stats: LibraryStats;
  activityDays: ActivityDay[];
}) {
  const hours = Math.round(stats.watchTimeMinutes / 60);
  const days = Math.floor(hours / 24);
  const watchTime = days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`;

  // "Any watch activity" gates the activity heatmap specifically (it needs
  // dated events). Sparse/rich is broader: a library that's been rated or
  // marked watched (e.g. via bulk import, which doesn't carry watch dates)
  // already has real charts to show, even with zero active days.
  const hasActivity = stats.activeDays > 0;
  const hasWatchData =
    hasActivity ||
    stats.ratedCount > 0 ||
    stats.watchedMovies > 0 ||
    stats.watchedEpisodes > 0;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Stats</h1>

      {!hasWatchData ? (
        <Card variant="panel" className="p-6">
          <h2 className="text-base font-semibold tracking-tight">
            Your stats build as you watch
          </h2>
          <p className="mt-1 text-sm text-muted">
            Mark titles watched and rate what you have seen, and your
            activity, ratings, and genre breakdowns will show up here.
          </p>
          <div className="mt-5 grid max-w-md grid-cols-3 gap-3">
            <Kpi label="Titles" value={stats.total} />
            <Kpi label="Movies" value={stats.movies} />
            <Kpi label="TV shows" value={stats.tv} />
          </div>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2">
            <Link
              href="/?status=watchlist"
              className="focus-ring inline-flex min-h-11 items-center rounded text-sm font-medium text-brand hover:underline sm:min-h-0"
            >
              Mark titles watched
            </Link>
            <Link
              href="/?status=watched&rating=unrated"
              className="focus-ring inline-flex min-h-11 items-center rounded text-sm font-medium text-brand hover:underline sm:min-h-0"
            >
              Rate what you have seen
            </Link>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Titles" value={stats.total} />
            <Kpi label="Movies" value={stats.movies} />
            <Kpi label="TV shows" value={stats.tv} />
            <Kpi label="Movies watched" value={stats.watchedMovies} />
            <Kpi
              label="Episodes watched"
              value={stats.watchedEpisodes}
              hint={
                stats.episodesTotal > 0
                  ? `of ${stats.episodesTotal} tracked`
                  : undefined
              }
            />
            {/* "Est." only when something actually was estimated. With every
                watched episode's and movie's runtime known the figure is a
                sum, and the hedge would contradict the (correspondingly
                absent) note below. */}
            <Kpi
              label={
                stats.watchTimeEstimatedEpisodes > 0 ||
                stats.watchTimeEstimatedMovies > 0
                  ? "Est. watch time"
                  : "Watch time"
              }
              value={watchTime}
            />
            <Kpi label="Rewatches" value={stats.totalRewatches} />
          </div>
          {/* The caveat used to run whenever any episode was watched, which
              stopped being true once episode runtimes were summed for real:
              with every runtime known the total is the sum, not a guess. Say
              how much of it is estimated, and say nothing when none of it is.
              Runtime-less movies are rare but get the same treatment, folded
              into the same sentence rather than a second paragraph. */}
          {(stats.watchTimeEstimatedEpisodes > 0 ||
            stats.watchTimeEstimatedMovies > 0) && (
            <p className="-mt-3 text-xs text-faint">
              Watch time counts{" "}
              {stats.watchTimeEstimatedEpisodes > 0 && (
                <>
                  <span className="tabular-nums">
                    {stats.watchTimeEstimatedEpisodes}
                  </span>{" "}
                  watched episode{stats.watchTimeEstimatedEpisodes === 1 ? "" : "s"}{" "}
                  with no known runtime at about {ESTIMATED_EPISODE_MINUTES}{" "}
                  minutes each
                </>
              )}
              {stats.watchTimeEstimatedEpisodes > 0 &&
                stats.watchTimeEstimatedMovies > 0 &&
                " and "}
              {stats.watchTimeEstimatedMovies > 0 && (
                <>
                  <span className="tabular-nums">
                    {stats.watchTimeEstimatedMovies}
                  </span>{" "}
                  watched movie{stats.watchTimeEstimatedMovies === 1 ? "" : "s"}{" "}
                  with no known runtime at about {ESTIMATED_MOVIE_MINUTES}{" "}
                  minutes each
                </>
              )}
              .
            </p>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Hero: watch activity over time, when there is any. */}
            {hasActivity && (
              <Card className="p-5 lg:col-span-2">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">Watch activity</h2>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-2xl font-bold tracking-tight tabular-nums text-gradient">
                        {stats.currentStreak}
                      </span>
                      <span className="text-sm text-muted">day streak</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted">
                    <span className="flex items-center gap-1.5">
                      <Flame size={14} className="text-amber-400" />
                      Longest <span className="tabular-nums">{stats.longestStreak}</span>d
                    </span>
                    <span>
                      <span className="tabular-nums">{stats.activeDays}</span> active days
                    </span>
                  </div>
                </div>
                <ActivityCalendar
                  activity={stats.activity}
                  days={activityDays}
                  todayKey={stats.todayKey}
                />
              </Card>
            )}

            {/* Titles by year */}
            {stats.byYear.length > 1 && (
              <Card className="p-5">
                <h2 className="mb-4 text-sm font-semibold">Titles by release year</h2>
                <Sparkline
                  points={stats.byYear.map((y) => y.count)}
                  labels={[
                    String(stats.byYear[0].year),
                    String(stats.byYear[stats.byYear.length - 1].year),
                  ]}
                />
              </Card>
            )}

            {/* Rating distribution */}
            {stats.ratedCount > 0 && (
              <Card className="p-5">
                <h2 className="mb-1 text-sm font-semibold">Your ratings</h2>
                <p className="mb-4 text-xs text-muted">
                  <span className="tabular-nums">{stats.ratedCount}</span>{" "}
                  rated · average{" "}
                  <span className="tabular-nums">{stats.averageRating?.toFixed(1)}</span>/10
                </p>
                <ColumnChart
                  data={stats.ratingDistribution.map((r) => ({
                    label: String(r.rating),
                    value: r.count,
                  }))}
                />
              </Card>
            )}

            {/* By status */}
            <Card className="p-5">
              <h2 className="mb-4 text-sm font-semibold">By status</h2>
              <div className="flex flex-col gap-2.5">
                {STATUS_ORDER.map((s) => (
                  <BarRow
                    key={s}
                    label={STATUS_META[s].label}
                    value={stats.byStatus[s as WatchStatus]}
                    max={stats.total}
                    colorClass={STATUS_META[s].dot}
                  />
                ))}
              </div>
            </Card>

            {/* By language */}
            {stats.byLanguage.length > 0 && (
              <Card className="p-5">
                <h2 className="mb-4 text-sm font-semibold">By language</h2>
                <div className="flex flex-col gap-2.5">
                  {stats.byLanguage.slice(0, 8).map((l) => (
                    <BarRow
                      key={l.code}
                      label={languageName(l.code)}
                      value={l.count}
                      max={stats.byLanguage[0]?.count ?? 1}
                    />
                  ))}
                </div>
              </Card>
            )}

            {/* By decade */}
            {stats.byDecade.length > 0 && (
              <Card className="p-5">
                <h2 className="mb-4 text-sm font-semibold">By decade</h2>
                <ColumnChart
                  data={stats.byDecade.map((d) => ({ label: d.decade, value: d.count }))}
                />
              </Card>
            )}

            {/* Taste by genre */}
            {stats.byGenreRating.length > 0 && (
              <Card className="p-5">
                <h2 className="mb-1 text-sm font-semibold">Taste by genre</h2>
                <p className="mb-4 text-xs text-muted">
                  Your average rating, for genres with at least 2 rated titles.
                </p>
                <div className="flex flex-col gap-2.5">
                  {stats.byGenreRating.map((g) => (
                    <BarRow key={g.genre} label={g.genre} value={g.avg} max={10} />
                  ))}
                </div>
              </Card>
            )}

            {/* Top rated */}
            {stats.topRated.length > 0 && (
              <Card className="p-5">
                <h2 className="mb-1 text-sm font-semibold">Your top rated</h2>
                <p className="mb-4 text-xs text-muted">
                  <span className="tabular-nums">{stats.ratedCount}</span>{" "}
                  rated · average{" "}
                  <span className="tabular-nums">{stats.averageRating?.toFixed(1)}</span>/10
                </p>
                <ol className="flex flex-col gap-1.5">
                  {stats.topRated.map((t, i) => (
                    <li key={t.id}>
                      <Link
                        href={`/title/${t.id}`}
                        className="focus-ring flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-2/50"
                      >
                        <span className="w-5 text-xs tabular-nums text-faint">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        <span className="tabular-nums text-amber-300">★ {t.rating}</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            {/* Most rewatched */}
            {stats.mostRewatched.length > 0 && (
              <Card className="p-5">
                <h2 className="mb-4 text-sm font-semibold">Most rewatched</h2>
                <ol className="flex flex-col gap-1.5">
                  {stats.mostRewatched.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/title/${t.id}`}
                        className="focus-ring flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-2/50"
                      >
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        <span className="tabular-nums text-muted">{t.count} times</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </Card>
            )}
          </div>

          {stats.byGenre.length > 0 && (
            <Card className="p-5">
              <h2 className="mb-4 text-sm font-semibold">Top genres</h2>
              <div className="flex flex-wrap gap-2">
                {stats.byGenre.map((g) => (
                  <span
                    key={g.genre}
                    className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-sm ring-1 ring-line"
                  >
                    {g.genre}
                    <span className="text-xs tabular-nums text-faint">{g.count}</span>
                  </span>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card variant="inset" className="p-4">
      <div className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1 text-xs text-muted">{label}</div>
      {hint && <div className="text-xs tabular-nums text-faint">{hint}</div>}
    </Card>
  );
}
