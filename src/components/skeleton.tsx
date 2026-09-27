import { cn } from "@/lib/utils";

/** A single shimmering placeholder block. */
export function Shimmer({ className }: { className?: string }) {
  return <div className={cn("rounded-lg bg-surface-2 shimmer", className)} />;
}

// Announced through the app shell's live region (JK-23).
export { LoadingStatus } from "@/components/route-status";
