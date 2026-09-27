"use client";

import { useState, useTransition } from "react";
import { Globe } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { updatePreferences } from "@/lib/settings-actions";
import { regionName, watchRegionOptions } from "@/lib/tmdb-extras";
import { Notice, Section } from "./settings-ui";

/** Time zones offered in the preferences picker (IANA identifiers). Falls
 * back to a minimal list if the enumeration API isn't available. UTC, the
 * default, leads the list: supportedValuesOf omits it as a non-canonical alias. */
const TIME_ZONES: string[] =
  typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function"
    ? ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")]
    : ["UTC"];

export function PreferencesSection({
  timeZone,
  watchRegion,
  watchRegions,
}: {
  timeZone: string;
  watchRegion: string;
  watchRegions: string[];
}) {
  const [tz, setTz] = useState(timeZone);
  const [region, setRegion] = useState(watchRegion);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  // Defensive: keep the stored value selectable even if it's missing from
  // the enumerated list (e.g. a legacy alias on an older ICU build).
  const timeZoneOptions: readonly string[] = TIME_ZONES.includes(tz)
    ? TIME_ZONES
    : [tz, ...TIME_ZONES];
  // TMDB's full list, sorted by name so typing a country's first letters in
  // the open picker jumps to it.
  const regionOptions = watchRegionOptions(watchRegions, region);

  const dirty = tz !== timeZone || region !== watchRegion;

  return (
    <Section icon={Globe} title="Preferences">
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Time zone</span>
          <Select
            name="time-zone"
            value={tz}
            className="w-full"
            onChange={(e) => setTz(e.target.value)}
          >
            {timeZoneOptions.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
          <span className="text-xs text-faint">
            Used for stats day boundaries and streaks.
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Default watch region</span>
          <Select
            name="default-watch-region"
            value={region}
            className="w-full"
            onChange={(e) => setRegion(e.target.value)}
          >
            {regionOptions.map((r) => (
              <option key={r} value={r}>
                {regionName(r)}
              </option>
            ))}
          </Select>
          <span className="text-xs text-faint">
            Default region for streaming availability.
          </span>
        </label>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={pending || !dirty}
          onClick={() =>
            start(async () => {
              try {
                const r = await updatePreferences({ timeZone: tz, watchRegion: region });
                if (r.error) {
                  setMsg({ kind: "error", text: r.error });
                } else {
                  setMsg({ kind: "ok", text: "Preferences saved." });
                  setTimeout(() => setMsg(null), 1500);
                }
              } catch {
                setMsg({
                  kind: "error",
                  text: "Celluloid couldn't save your preferences. Check your connection and retry.",
                });
              }
            })
          }
        >
          Save
        </Button>
      </div>
    </Section>
  );
}
