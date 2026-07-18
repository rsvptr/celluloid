"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { Wordmark } from "@/components/brand";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced in the server logs via Next; nothing sensitive shown to the user.
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-4 text-center">
      <Wordmark size={40} href={null} className="flex-col gap-2" />
      <div>
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Sorry, that didn&apos;t load. You can try again, or head back to your
          library.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={reset}>
          Try again
        </Button>
        <Link
          href="/"
          className="focus-ring inline-flex min-h-11 items-center justify-center rounded-lg bg-surface-2 px-3 text-sm font-medium text-foreground ring-1 ring-line-strong transition-colors hover:bg-surface-2/70 sm:min-h-9"
        >
          Go to library
        </Link>
      </div>
    </div>
  );
}
