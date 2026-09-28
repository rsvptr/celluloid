"use client";

import { History } from "lucide-react";
import type { AuthEventSummary } from "@/lib/auth-events";
import { authEventLabel } from "@/lib/auth-event-labels";
import { deviceLabel } from "./devices-section";
import { Notice, Section } from "./settings-ui";

/**
 * When an event happened, in the account's zone (User.timeZone) and the en-US
 * form Devices uses. Falls back to UTC on a zone Intl rejects.
 */
function eventTime(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(iso));
  }
}

/**
 * The auth audit trail (BA-15): the account's latest sign-ins, sign-outs and
 * security changes, read server-side. It outlives the session rows that a
 * password change or "Sign out everywhere else" deletes.
 */
export function AccountActivitySection({
  events,
  timeZone,
}: {
  /** Newest first. Null when the server couldn't read them. */
  events: AuthEventSummary[] | null;
  timeZone: string;
}) {
  return (
    <Section
      icon={History}
      title="Account activity"
      description={`Recent sign-ins and security changes, kept for 90 days. Times are in ${timeZone}.`}
    >
      {events === null ? (
        <Notice kind="error">
          Celluloid couldn&apos;t load your account activity. Reload the page to try again.
        </Notice>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted">No account activity yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {events.map((event) => (
            <li key={event.id} className="py-2 first:pt-0 last:pb-0">
              <p className="text-sm font-medium">{authEventLabel(event.type)}</p>
              <p className="mt-0.5 text-xs text-muted">
                {/* Server and browser ICU builds can space "PM" differently. */}
                <time dateTime={event.createdAt} suppressHydrationWarning>
                  {eventTime(event.createdAt, timeZone)}
                </time>{" "}
                · {deviceLabel(event.userAgent)} ·{" "}
                {event.ipAddress ? `IP ${event.ipAddress}` : "IP unavailable"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
