import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import {
  getLibraryItems,
  getLibraryProviderPreferences,
  getTags,
  getTrashedTitles,
} from "@/lib/data";
import { parseLibraryFilters } from "@/lib/library-filters";
import {
  hasExplicitLibraryFilterParams,
  isRememberFiltersEnabled,
  libraryRememberedStateToParams,
  parseLibraryRememberedState,
  REMEMBERED_COOKIE_NAMES,
  REMEMBER_FILTERS_TOGGLE_COOKIE,
} from "@/lib/remembered-state";
import { resolveWatchRegion } from "@/lib/watch-region";
import { Library } from "@/components/library";

// "Library · Celluloid", like every other page (JK-23).
export const metadata: Metadata = { title: "Library" };

const PROVIDER_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

function providerStaleCutoffIso(): string {
  return new Date(new Date().getTime() - PROVIDER_FRESHNESS_MS).toISOString();
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [sp, items, tags, trashed, providerPreferences, cookieStore] =
    await Promise.all([
      searchParams,
      getLibraryItems(user.id),
      getTags(user.id),
      getTrashedTitles(user.id),
      getLibraryProviderPreferences(user.id),
      cookies(),
    ]);
  // D-008: "On my services" answers for the account region, because that is the
  // region the nightly provider sync writes into every cached row. The
  // per-device cookie steers only the title page's provider strip, so a phone
  // whose cookie still said US after the account moved to IN no longer reads
  // its whole library as unchecked.
  const accountRegion = resolveWatchRegion(null, providerPreferences?.watchRegion);
  const providerStaleBefore = providerStaleCutoffIso();

  const tagNames = tags.map((t) => t.name);
  // Tag name -> stored colour. getTags already selects the colour and <Library>
  // already knows how to paint a chip with it, but nothing joined the two: every
  // chip in the list view rendered neutral, so the colour picked in Settings had
  // no effect anywhere outside Settings. Built from the rows already in hand — no
  // extra query.
  const tagColors: Record<string, string | null> = Object.fromEntries(
    tags.map((t) => [t.name, t.color]),
  );
  // Facets derive from the items already in hand — no extra queries.
  const languages = [...new Set(items.map((it) => it.language).filter((l): l is string => !!l))].sort();
  const genres = [...new Set(items.flatMap((it) => it.genres))].sort();
  const rememberFilters = isRememberFiltersEnabled(
    cookieStore.get(REMEMBER_FILTERS_TOGGLE_COOKIE)?.value,
  );
  const initialFilterParams =
    rememberFilters && !hasExplicitLibraryFilterParams(sp)
      ? libraryRememberedStateToParams(
          parseLibraryRememberedState(
            cookieStore.get(REMEMBERED_COOKIE_NAMES.library)?.value,
          ),
        )
      : sp;
  const initialFilters = parseLibraryFilters(initialFilterParams, {
    languages,
    tags: tagNames,
    genres,
  });

  return (
    <Library
      items={items}
      languages={languages}
      tags={tagNames}
      tagColors={tagColors}
      genres={genres}
      trashed={trashed}
      initialFilters={initialFilters}
      myProviders={providerPreferences?.myProviders ?? []}
      accountRegion={accountRegion}
      providerStaleBefore={providerStaleBefore}
      rememberFilters={rememberFilters}
    />
  );
}
