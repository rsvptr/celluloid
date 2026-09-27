import type { TitleBundle } from "@/lib/tmdb";
import { fullDate } from "@/lib/format";
import { regionName, type RegionalRelease } from "@/lib/tmdb-extras";

function releaseText(release: RegionalRelease, region: string): string {
  const date = fullDate(release.date);
  if (release.type === 3) return `In cinemas in ${regionName(region)} on ${date}`;
  if (release.type === 4) return `Digital on ${date}`;
  return `On disc on ${date}`;
}

/**
 * When a watchlisted film reaches the viewer's region: in cinemas, digitally
 * and on disc, from TMDB's release dates for that region. It reads the page's
 * one bundle request, so it costs no TMDB call of its own, and it streams in
 * under the release date so the hero never waits on TMDB.
 */
export async function RegionalReleases({
  bundle,
  region,
}: {
  bundle: Promise<TitleBundle | null>;
  region: string;
}) {
  const releases = (await bundle)?.releases ?? [];
  if (releases.length === 0) return null;
  return (
    <p className="text-sm text-muted">
      {releases.map((release) => releaseText(release, region)).join(" · ")}
    </p>
  );
}
