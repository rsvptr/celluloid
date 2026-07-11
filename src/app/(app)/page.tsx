import { requireUser } from "@/lib/session";
import { getLibraryItems, getTags } from "@/lib/data";
import { filtersToParams, parseLibraryFilters } from "@/lib/library-filters";
import { Library } from "@/components/library";

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [sp, items, tags] = await Promise.all([
    searchParams,
    getLibraryItems(user.id),
    getTags(user.id),
  ]);

  const tagNames = tags.map((t) => t.name);
  // Facets derive from the items already in hand — no extra queries.
  const languages = [...new Set(items.map((it) => it.language).filter((l): l is string => !!l))].sort();
  const genres = [...new Set(items.flatMap((it) => it.genres))].sort();
  const initialFilters = parseLibraryFilters(sp, {
    languages,
    tags: tagNames,
    genres,
  });

  return (
    <Library
      // Remount when back/forward navigation changes the filter params, so the
      // restored URL actually re-applies its filters (typing only touches the
      // URL via replaceState, which never re-renders this server component).
      key={filtersToParams(initialFilters).toString()}
      items={items}
      languages={languages}
      tags={tagNames}
      genres={genres}
      initialFilters={initialFilters}
    />
  );
}
