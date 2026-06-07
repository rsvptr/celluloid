import { cn } from "@/lib/utils";

/** A single shimmering placeholder block. */
export function Shimmer({ className }: { className?: string }) {
  return <div className={cn("rounded-lg bg-surface-2 shimmer", className)} />;
}
