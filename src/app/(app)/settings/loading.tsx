import { LoadingStatus, Shimmer } from "@/components/skeleton";

export default function Loading() {
  return (
    // Matches the page's full-shell width so navigation doesn't width-jump;
    // skeletons pair 2-up at lg like the real Section grid.
    <div aria-busy="true">
      <LoadingStatus>Loading settings…</LoadingStatus>
      <Shimmer className="mb-6 h-7 w-28" />
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-2 lg:items-start">
        {Array.from({ length: 6 }).map((_, i) => (
          <Shimmer key={i} className="h-32" />
        ))}
      </div>
    </div>
  );
}
