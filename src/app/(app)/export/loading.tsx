import { Shimmer } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <Shimmer className="h-7 w-28" />
      <Shimmer className="h-40" />
      <Shimmer className="h-64" />
    </div>
  );
}
