import { LoadingStatus, Shimmer } from "@/components/skeleton";

export default function Loading() {
  return (
    // Matches the page's full-shell width so navigation doesn't width-jump.
    <div className="flex flex-col gap-5" aria-busy="true">
      <LoadingStatus>Loading recommendations…</LoadingStatus>
      <Shimmer className="h-7 w-56" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Shimmer key={i} className="h-8 w-32 rounded-full" />
        ))}
      </div>
      <Shimmer className="h-44" />
    </div>
  );
}
