"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Clapperboard, Search } from "lucide-react";
import { TmdbImage } from "@/components/tmdb-image";
import { Button, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { updateMyProviders } from "@/lib/settings-actions";
import { regionName } from "@/lib/tmdb-extras";
import { Notice, Section } from "./settings-ui";

/** Minimal, serializable provider data passed across the RSC boundary. */
export interface ProviderOption {
  id: number;
  name: string;
  logoPath: string | null;
}

function sortedProviderIds(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

export function MyServicesSection({
  region,
  initialProviderIds,
  providers,
  unavailable,
}: {
  region: string;
  initialProviderIds: number[];
  providers: ProviderOption[];
  unavailable: boolean;
}) {
  const availableIds = useMemo(() => new Set(providers.map((provider) => provider.id)), [providers]);
  const availableInitialIds = useMemo(
    () => sortedProviderIds(initialProviderIds.filter((id) => availableIds.has(id))),
    [availableIds, initialProviderIds],
  );
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(availableInitialIds),
  );
  const [savedIds, setSavedIds] = useState<number[]>(availableInitialIds);
  const [unavailableCount, setUnavailableCount] = useState(
    () => initialProviderIds.length - availableInitialIds.length,
  );
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const selectedIds = useMemo(() => sortedProviderIds(selected), [selected]);
  const dirty =
    unavailableCount > 0 || selectedIds.join(",") !== savedIds.join(",");
  const foldedQuery = query.trim().toLocaleLowerCase();
  const visibleProviders = useMemo(
    () =>
      foldedQuery
        ? providers.filter((provider) =>
            provider.name.toLocaleLowerCase().includes(foldedQuery),
          )
        : providers,
    [foldedQuery, providers],
  );

  function toggleProvider(id: number) {
    setMsg(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  }

  return (
    <Section
      icon={Clapperboard}
      title="My services"
      description={`Choose the streaming services you use in ${regionName(region)}. The Library can then answer “what can I watch tonight?” in one tap.`}
    >
      {unavailable ? (
        <Notice kind="error">
          Celluloid couldn&apos;t load the service list right now. Your existing choices are
          unchanged; refresh to try again.
        </Notice>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 sm:max-w-sm sm:flex-1">
              <Search
                aria-hidden="true"
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search streaming services"
                placeholder="Find a streaming service…"
                spellCheck={false}
                className="w-full pl-9"
              />
            </div>
            <div className="flex items-center justify-between gap-3 sm:justify-end">
              <p className="text-xs tabular-nums text-muted" role="status" aria-live="polite">
                {selected.size} selected
              </p>
              {selected.size > 0 ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setSelected(new Set());
                    setMsg(null);
                  }}
                  className="focus-ring flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-muted transition-colors hover:text-foreground disabled:opacity-50 sm:min-h-8"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          {unavailableCount > 0 ? (
            <p className="text-xs text-amber-300">
              {unavailableCount} previously selected {unavailableCount === 1 ? "service is" : "services are"}
              {" "}not offered in {regionName(region)}. Saving removes {unavailableCount === 1 ? "it" : "them"}.
            </p>
          ) : null}

          {/* Concentric corners, capped at the card: list at the card radius
              (14.4px), tile rounded-lg (about 14.4 - p-2), logo rounded (4px).
              All three were rounded-lg (JK-34). */}
          <div className="max-h-80 overflow-y-auto rounded-[var(--radius-card)] bg-surface-2/50 p-2 ring-1 ring-line">
            {visibleProviders.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {visibleProviders.map((provider) => {
                  const isSelected = selected.has(provider.id);
                  const atLimit = selected.size >= 100 && !isSelected;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      aria-pressed={isSelected}
                      disabled={pending || atLimit}
                      onClick={() => toggleProvider(provider.id)}
                      title={atLimit ? "You can choose up to 100 services" : provider.name}
                      className={cn(
                        "focus-ring flex min-h-14 min-w-0 items-center gap-2 rounded-lg p-2 text-left text-xs ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                        isSelected
                          ? "bg-brand/15 text-foreground ring-brand/40"
                          : "bg-surface text-muted ring-line hover:text-foreground hover:ring-line-strong",
                      )}
                    >
                      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2 ring-1 ring-line">
                        {provider.logoPath ? (
                          <TmdbImage
                            path={provider.logoPath}
                            kind="logo"
                            maxSize="w92"
                            alt=""
                            width={36}
                            height={36}
                            className="h-9 w-9 object-cover"
                          />
                        ) : (
                          <span aria-hidden="true" className="font-semibold text-faint">
                            {provider.name.slice(0, 1)}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                      {isSelected ? (
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-on-accent">
                          <Check aria-hidden="true" size={13} strokeWidth={3} />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="px-3 py-8 text-center text-sm text-muted">
                {query.trim()
                  ? "No services match that search."
                  : `No streaming services are listed for ${regionName(region)}.`}
              </p>
            )}
          </div>

          <p className="text-xs text-faint">
            Availability data via JustWatch. Rentals and purchases do not count as being
            on your services; library availability refreshes nightly.
          </p>
          {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={pending || !dirty}
            onClick={() =>
              start(async () => {
                setMsg(null);
                try {
                  const result = await updateMyProviders(selectedIds);
                  if (result.error) {
                    setMsg({ kind: "error", text: result.error });
                    return;
                  }
                  setSavedIds(selectedIds);
                  setUnavailableCount(0);
                  setMsg({ kind: "ok", text: "Services saved." });
                } catch {
                  setMsg({
                    kind: "error",
                    text: "Celluloid couldn't save your services. Check your connection and retry.",
                  });
                }
              })
            }
          >
            {pending ? <Spinner /> : null}
            {pending ? "Saving…" : "Save services"}
          </Button>
        </div>
      )}
    </Section>
  );
}
