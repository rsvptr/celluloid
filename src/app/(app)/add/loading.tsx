import { Shimmer } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <Shimmer className="h-7 w-36" />
      <Shimmer className="h-12 w-full" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Shimmer key={i} className="h-16" />
        ))}
      </div>
    </div>
  );
}
