import Link from "next/link";
import { Wordmark } from "@/components/brand";

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-5 px-4 text-center">
      <Wordmark size={40} href={null} className="flex-col gap-2" />
      <div>
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-1 max-w-sm text-sm text-muted">
          We couldn&apos;t find what you were looking for. It may have been
          removed, or the link is wrong.
        </p>
      </div>
      <Link href="/" className="focus-ring rounded text-sm font-medium text-brand hover:underline">
        Go to your library →
      </Link>
    </div>
  );
}
