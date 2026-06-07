import { requireUser } from "@/lib/session";
import { getDistinctLanguages, getLibraryItems, getTags } from "@/lib/data";
import { Library } from "@/components/library";

export default async function LibraryPage() {
  const user = await requireUser();
  const [items, languages, tags] = await Promise.all([
    getLibraryItems(user.id),
    getDistinctLanguages(user.id),
    getTags(user.id),
  ]);

  return (
    <Library
      items={items}
      languages={languages}
      tags={tags.map((t) => t.name)}
    />
  );
}
