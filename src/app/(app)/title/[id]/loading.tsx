import { Shimmer } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <Shimmer className="h-5 w-20" />
      <div className="flex flex-col gap-5 rounded-[var(--radius-card)] p-5 ring-1 ring-line sm:flex-row sm:p-6">
        <Shimmer className="aspect-[2/3] w-32 shrink-0 sm:w-44" />
        <div className="flex flex-1 flex-col gap-3">
          <Shimmer className="h-5 w-24" />
          <Shimmer className="h-8 w-2/3" />
          <Shimmer className="h-4 w-1/2" />
          <Shimmer className="h-20 w-full max-w-2xl" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Shimmer className="h-64 lg:col-span-2" />
        <Shimmer className="h-64" />
      </div>
    </div>
  );
}
