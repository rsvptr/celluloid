import { requireUser } from "@/lib/session";
import { getLibraryItems, getTags, getTrashedTitles } from "@/lib/data";
import { filtersToParams, parseLibraryFilters } from "@/lib/library-filters";
import { Library } from "@/components/library";

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [sp, items, tags, trashed] = await Promise.all([
    searchParams,
    getLibraryItems(user.id),
    getTags(user.id),
    getTrashedTitles(user.id),
  ]);

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
      tagColors={tagColors}
      genres={genres}
      trashed={trashed}
      initialFilters={initialFilters}
    />
  );
}
