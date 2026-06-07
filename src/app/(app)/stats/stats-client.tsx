"use client";

import Link from "next/link";
import { Flame } from "lucide-react";
import type { LibraryStats } from "@/lib/data";
import { Card } from "@/components/ui";
import {
  ActivityHeatmap,
  BarRow,
  ColumnChart,
  Sparkline,
} from "@/components/charts";
import { STATUS_META, STATUS_ORDER, languageName } from "@/lib/format";
import type { WatchStatus } from "@/generated/prisma/client";

export function StatsClient({ stats }: { stats: LibraryStats }) {
  const hours = Math.round(stats.watchTimeMinutes / 60);
  const days = Math.floor(hours / 24);
  const watchTime = days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Stats</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Titles" value={stats.total} />
        <Kpi label="Movies" value={stats.movies} />
        <Kpi label="TV shows" value={stats.tv} />
        <Kpi label="Movies watched" value={stats.watchedMovies} />
        <Kpi label="Episodes watched" value={stats.watchedEpisodes} />
        <Kpi label="Est. watch time" value={watchTime} />
      </div>
      {stats.watchedEpisodes > 0 && (
        <p className="-mt-3 text-xs text-faint">
          Watch time is an estimate; episodes without a known runtime count as
          about 42 minutes each.
        </p>
      )}

      {/* Watch activity */}
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Watch activity</h2>
          <div className="flex items-center gap-4 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <Flame size={14} className="text-amber-400" /> {stats.currentStreak}-day streak
            </span>
            <span>Longest {stats.longestStreak}d</span>
            <span>{stats.activeDays} active days</span>
          </div>
        </div>
        {stats.activeDays === 0 ? (
          <p className="text-sm text-muted">
            Your imported titles do not carry watch dates, so this starts empty.
            As you mark movies and episodes watched in the app, your activity
            lights up here.
          </p>
        ) : (
          <ActivityHeatmap activity={stats.activity} />
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Titles by year */}
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Titles by release year</h2>
          {stats.byYear.length > 1 ? (
            <Sparkline
              points={stats.byYear.map((y) => y.count)}
              labels={[
                String(stats.byYear[0].year),
                String(stats.byYear[stats.byYear.length - 1].year),
              ]}
            />
          ) : (
            <p className="text-sm text-muted">Not enough release-date data.</p>
          )}
        </Card>

        {/* Rating distribution */}
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold">Your ratings</h2>
          <p className="mb-4 text-xs text-muted">
            {stats.ratedCount > 0
              ? `${stats.ratedCount} rated · avg ${stats.averageRating?.toFixed(1)}/10`
              : "Rate some titles to see the distribution."}
          </p>
          {stats.ratedCount > 0 ? (
            <ColumnChart
              data={stats.ratingDistribution.map((r) => ({
                label: String(r.rating),
                value: r.count,
              }))}
            />
          ) : (
            <p className="text-sm text-muted">No ratings yet.</p>
          )}
        </Card>

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
            {stats.byLanguage.length === 0 && (
              <p className="text-sm text-muted">No language data.</p>
            )}
          </div>
        </Card>

        {/* By decade */}
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">By decade</h2>
          {stats.byDecade.length > 0 ? (
            <ColumnChart
              data={stats.byDecade.map((d) => ({ label: d.decade, value: d.count }))}
            />
          ) : (
            <p className="text-sm text-muted">No release-date data.</p>
          )}
        </Card>

        {/* Top rated */}
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold">Your top rated</h2>
          <p className="mb-4 text-xs text-muted">
            {stats.ratedCount > 0
              ? `${stats.ratedCount} rated · average ${stats.averageRating?.toFixed(1)}/10`
              : "Rate some titles to see them here."}
          </p>
          <ol className="flex flex-col gap-1.5">
            {stats.topRated.map((t, i) => (
              <li key={t.id}>
                <Link
                  href={`/title/${t.id}`}
                  className="focus-ring flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-2/50"
                >
                  <span className="w-5 text-xs text-faint">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="text-amber-300">★ {t.rating}</span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
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
                <span className="text-xs text-faint">{g.count}</span>
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="p-4">
      <div className="text-2xl font-bold tracking-tight text-gradient">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </Card>
  );
}
