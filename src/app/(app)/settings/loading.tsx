import { Shimmer } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl">
      <Shimmer className="mb-6 h-7 w-28" />
      <div className="flex flex-col gap-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Shimmer key={i} className="h-32" />
        ))}
      </div>
    </div>
  );
}
