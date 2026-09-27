import { LoadingStatus, Shimmer } from "@/components/skeleton";

/**
 * Stands in for the library (src/components/library.tsx) while it streams in.
 * Block heights and row structure track the real toolbar and cards — heading,
 * search row, type/filters row, utility row, then poster + two caption lines —
 * so nothing below shifts when the page hydrates.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5 pb-24" aria-busy="true">
      <LoadingStatus>Loading your library…</LoadingStatus>
      <div className="flex flex-col gap-4">
        <Shimmer className="h-7 w-32 rounded" />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Shimmer className="order-last h-11 w-full sm:order-none sm:h-10 sm:w-auto sm:max-w-md sm:flex-1" />
          <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-normal">
            <Shimmer className="h-4 w-16 rounded" />
            <Shimmer className="h-11 w-28 sm:h-10" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Shimmer className="h-12 w-56 sm:h-9 sm:w-48" />
          <Shimmer className="ml-auto h-11 w-24 sm:h-8" />
        </div>

        <div className="flex items-center justify-end gap-2">
          <Shimmer className="h-11 w-11 sm:h-8 sm:w-24" />
          <Shimmer className="h-11 w-11 sm:h-8 sm:w-28" />
          <Shimmer className="h-11 w-11 sm:h-8 sm:w-24" />
          <Shimmer className="h-12 w-24 sm:h-8 sm:w-16" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-6 min-[480px]:grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
        {Array.from({ length: 14 }).map((_, i) => (
          <div key={i}>
            <Shimmer className="aspect-[2/3] w-full" />
            {/* h-11 is the card's caption block exactly: a 20px title line plus
                a 16px meta line, both flush under the same mt-2. */}
            <div className="mt-2 flex h-11 flex-col justify-between">
              <Shimmer className="h-4 w-4/5 rounded" />
              <Shimmer className="h-3 w-1/2 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
