"use client";

import { createContext, use } from "react";
import type { LibraryFilterState, LibraryFilterUpdate } from "@/lib/library-filter-state";

/**
 * The library's filters as the toolbar rows, the advanced panel and the
 * results read them: the state, the ways to change it, and the facet options
 * the library offers. <Library> provides it from its reducer.
 */
export interface LibraryFiltersContextValue {
  state: LibraryFilterState;
  actions: {
    set: (update: LibraryFilterUpdate) => void;
    clear: () => void;
  };
  meta: {
    languages: string[];
    genres: string[];
    tags: string[];
  };
}

export const LibraryFiltersContext = createContext<LibraryFiltersContextValue | null>(null);

export function useLibraryFilters(): LibraryFiltersContextValue {
  return use(LibraryFiltersContext)!;
}
