import { Wordmark } from "@/components/brand";

/**
 * An unknown, revoked, expired or rate-limited share link (the page calls
 * notFound() for all four). The visitor is usually signed out and has no
 * library, so there is no library link: the only way forward is a new link
 * from whoever shared it (JK-19).
 */
export default function ShareNotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center gap-5 px-4 text-center">
      <Wordmark size={40} href={null} className="flex-col gap-2" />
      <div>
        <h1 className="text-lg font-semibold">This shared list isn&apos;t available</h1>
        <p className="mt-1 max-w-sm text-sm text-muted">
          The link may have expired or been revoked. Ask the person who shared it
          for a new link.
        </p>
      </div>
    </main>
  );
}
