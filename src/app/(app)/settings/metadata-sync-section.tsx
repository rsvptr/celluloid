"use client";

import Link from "next/link";
import { AlertTriangle, Check } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { Notice, Section } from "./settings-ui";

/** One title whose most recent scheduled metadata refresh failed. */
export interface MetadataFailureSummary {
  id: string;
  name: string;
  mediaType: "MOVIE" | "TV";
  metadataLastError: string | null;
}

export function MetadataSyncSection({
  failures,
}: {
  failures: MetadataFailureSummary[];
}) {
  return (
    <Section
      icon={failures.length > 0 ? AlertTriangle : Check}
      title="Metadata refresh"
      description="Problems from the latest scheduled TMDB refresh appear here."
    >
      {failures.length === 0 ? (
        <Notice kind="ok">No refresh problems right now.</Notice>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-amber-200">
            {failures.length} {failures.length === 1 ? "title needs" : "titles need"} a
            successful refresh. Celluloid will try again on a later scheduled run.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {failures.map((failure) => (
              <li key={failure.id}>
                <Card variant="inset" className="h-full p-3">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={`/title/${failure.id}`}
                      className="text-sm font-medium text-foreground underline decoration-line underline-offset-4 transition-colors hover:text-brand"
                    >
                      {failure.name}
                    </Link>
                    <Badge>{failure.mediaType === "TV" ? "TV" : "Movie"}</Badge>
                  </div>
                  <p className="mt-2 break-words text-xs text-muted">
                    {failure.metadataLastError ??
                      "The refresh failed before Celluloid received an error message."}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
