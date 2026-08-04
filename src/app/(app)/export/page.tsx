import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { getExportRows, getTags } from "@/lib/data";
import {
  hasExplicitExportScopeParams,
  isRememberFiltersEnabled,
  parseExportRememberedState,
  REMEMBERED_COOKIE_NAMES,
  REMEMBER_FILTERS_TOGGLE_COOKIE,
} from "@/lib/remembered-state";
import { ExportPanel } from "./export-panel";

export const metadata: Metadata = { title: "Export" };

export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [rows, tags, sp, cookieStore] = await Promise.all([
    getExportRows(user.id),
    getTags(user.id),
    searchParams,
    cookies(),
  ]);
  const rememberFilters = isRememberFiltersEnabled(
    cookieStore.get(REMEMBER_FILTERS_TOGGLE_COOKIE)?.value,
  );
  const remembered = rememberFilters
    ? parseExportRememberedState(
        cookieStore.get(REMEMBERED_COOKIE_NAMES.export)?.value,
      )
    : null;

  // Scope hints from a library "Export these" deep link. Raw here; the panel
  // validates everything against the actual library before applying.
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const urlScope = {
    type: one("type"),
    status: one("status"),
    tag: one("tag"),
    genre: one("genre"),
    language: one("lang"),
    minRating: one("min"),
    yearFrom: one("from"),
    yearTo: one("to"),
    favoritesOnly: one("fav"),
  };
  const initialScope = hasExplicitExportScopeParams(sp)
    ? urlScope
    : remembered?.scope ?? urlScope;

  return (
    // Full shell width (D-UI-17 amendment): no per-page cap.
    <div>
      <ExportPanel
        rows={rows}
        tags={tags.map((t) => t.name)}
        initialScope={initialScope}
        initialFormat={remembered?.format}
        rememberFilters={rememberFilters}
      />
    </div>
  );
}
