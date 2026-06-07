import { Shimmer } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
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
