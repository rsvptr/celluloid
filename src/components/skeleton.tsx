import { cn } from "@/lib/utils";

/** A single shimmering placeholder block. */
export function Shimmer({ className }: { className?: string }) {
  return <div className={cn("rounded-lg bg-surface-2 shimmer", className)} />;
}

/**
 * Screen-reader text for a loading skeleton, which is otherwise silent
 * (JK-23). Sits inside the skeleton's aria-busy root.
 */
export function LoadingStatus({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="sr-only">
      {children}
    </p>
  );
}
