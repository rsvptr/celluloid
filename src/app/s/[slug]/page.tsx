import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSharePayload } from "@/lib/data";
import { Wordmark } from "@/components/brand";
import { TitleCard } from "@/components/title-card";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const payload = await getSharePayload(slug);
  const title = payload
    ? payload.name
      ? `${payload.name} · ${payload.ownerName}`
      : `${payload.ownerName}'s list`
    : "Shared list";
  return {
    title,
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const payload = await getSharePayload(slug);
  if (!payload) notFound();

  const { items, name, ownerName, includeNotes } = payload;
  const movies = items.filter((i) => i.mediaType === "MOVIE").length;
  const tv = items.length - movies;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
      <header className="mb-8 flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">
          {name ?? `${ownerName}'s list`}
        </h1>
        <p className="text-sm text-muted">
          Shared by {ownerName} · {items.length}{" "}
          {items.length === 1 ? "title" : "titles"}
          {movies > 0 && tv > 0 ? ` (${movies} movies · ${tv} TV)` : ""}
        </p>
      </header>

      {items.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted">
          This list is empty.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
          {items.map((it) => (
            <div key={it.id}>
              <TitleCard item={it} href={null} />
              {includeNotes && it.notes ? (
                <p className="mt-1 line-clamp-3 text-xs italic text-muted">
                  {it.notes}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <footer className="mt-14 flex flex-col items-center gap-2 border-t border-line pt-8 text-center">
        <Wordmark size={24} href="/" />
        <p className="text-xs text-faint">
          Track your own films & TV with Celluloid.
        </p>
      </footer>
    </main>
  );
}
