import { Shimmer } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Shimmer className="h-7 w-40" />
        <Shimmer className="h-4 w-72 max-w-full" />
      </div>
      {Array.from({ length: 2 }).map((_, section) => (
        <div key={section} className="flex flex-col gap-3">
          <Shimmer className="h-4 w-28" />
          <Shimmer className="h-32" />
        </div>
      ))}
    </div>
  );
}
