"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArchiveRestore,
  AlertTriangle,
  Check,
  ChevronDown,
  Clapperboard,
  Copy,
  Download,
  Globe,
  Info,
  KeyRound,
  Link2,
  MonitorSmartphone,
  Pencil,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag as TagIcon,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import type { AccountInfo, ShareSummary } from "@/lib/data";
import { authClient } from "@/lib/auth-client";
import { Badge, Button, Card, Input, Select, Spinner } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { TmdbAttribution } from "@/components/tmdb-attribution";
import { fullDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { deleteTag, renameTag, setTagColor } from "@/lib/actions";
import {
  removeAnthropicKey,
  setAnthropicKey,
  updateMyProviders,
  updatePreferences,
  updateProfile,
} from "@/lib/settings-actions";
import {
  deleteShareList,
  getShareListTitles,
  renameShareList,
  restoreShareList,
  revokeShareList,
  setShareExpiry,
  type SharedTitleSummary,
} from "@/lib/share-actions";
import {
  TAG_COLORS,
  TAG_COLOR_DEFAULT_SWATCH,
  TAG_COLOR_META,
  tagChipClass,
} from "@/lib/tag-colors";
import { isWatchRegion, regionName, WATCH_REGIONS } from "@/lib/tmdb-extras";
import { TMDB_IMAGE_BASE } from "@/lib/images";
import { setRememberFiltersEnabled } from "@/lib/remembered-state-client";
import { saveBlob } from "@/lib/save-blob";

/** One row of the tag manager: the tag plus how many live titles carry it. */
export interface TagSummary {
  id: string;
  name: string;
  color: string | null;
  count: number;
}

/** Minimal, serializable provider data passed across the RSC boundary. */
export interface ProviderOption {
  id: number;
  name: string;
  logoPath: string | null;
}

/** One title whose most recent scheduled metadata refresh failed. */
export interface MetadataFailureSummary {
  id: string;
  name: string;
  mediaType: "MOVIE" | "TV";
  metadataLastError: string | null;
}

// Chrome moves focus to <body> the instant a focused control becomes
// `disabled`. The buttons that open a confirm and then go busy carry
// `aria-disabled` and return early instead, so focus is still on them after
// confirming (JK-03). These classes reproduce Button's `disabled:` styling.
const softDisabledClass = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

export function SettingsClient({
  info,
  shares,
  tags,
  timeZone,
  watchRegion,
  myProviders,
  providers,
  providersUnavailable,
  metadataFailures,
  lastBackupAt,
  backupAgeDays,
  rememberFilters,
}: {
  info: AccountInfo;
  shares: ShareSummary[];
  tags: TagSummary[];
  timeZone: string;
  watchRegion: string;
  myProviders: number[];
  providers: ProviderOption[];
  providersUnavailable: boolean;
  metadataFailures: MetadataFailureSummary[];
  /** ISO timestamp of the last successful backup download, or null. */
  lastBackupAt: string | null;
  /** Whole days since that backup, measured server-side. Null when there is none. */
  backupAgeDays: number | null;
  rememberFilters: boolean;
}) {
  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-2">
      <ProfileSection name={info.name} email={info.email} />
      <PreferencesSection timeZone={timeZone} watchRegion={watchRegion} />
      <div className="lg:col-span-2">
        <MyServicesSection
          key={watchRegion}
          region={watchRegion}
          initialProviderIds={myProviders}
          providers={providers}
          unavailable={providersUnavailable}
        />
      </div>
      <RememberFiltersSection initialEnabled={rememberFilters} />
      <ApiKeySection hasApiKey={info.hasApiKey} hasServerKey={info.hasServerKey} />
      <SharedLinksSection shares={shares} />
      <TagsSection tags={tags} />
      <TwoFactorSection enabled={info.twoFactorEnabled} />
      <PasswordSection />
      <div className="lg:col-span-2">
        <DevicesSection />
      </div>
      <div className="lg:col-span-2">
        <MetadataSyncSection failures={metadataFailures} />
      </div>
      <BackupSection lastBackupAt={lastBackupAt} backupAgeDays={backupAgeDays} />
      <DangerSection />
      <div className="lg:col-span-2">
        <AboutSection />
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="h-full p-5">
      <div className="mb-4 flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 text-brand">
          <Icon size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
      </div>
      {children}
    </Card>
  );
}

function Notice({
  kind,
  children,
}: {
  kind: "ok" | "error";
  children: React.ReactNode;
}) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
      className={
        kind === "ok"
          ? "rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/20"
          : "rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20"
      }
    >
      {children}
    </p>
  );
}

function MetadataSyncSection({
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

async function copyText(text: string, okMsg = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
  } catch {
    toast.error("Couldn't copy that. Select it and copy manually.");
  }
}

/** Pull the base32 secret out of an otpauth:// URI (for manual TOTP entry). */
function secretFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return uri.match(/[?&]secret=([^&]+)/i)?.[1] ?? null;
  }
}

/** Group a secret into 4-char chunks for easier reading/typing. */
function groupSecret(s: string): string {
  return s.replace(/(.{4})/g, "$1 ").trim();
}

function ProfileSection({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <Section icon={User} title="Profile">
      <form
        method="post"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            try {
              const r = await updateProfile(value);
              if (r.error) {
                setMsg({ kind: "error", text: r.error });
              } else {
                setMsg({ kind: "ok", text: "Profile saved." });
                router.refresh();
                setTimeout(() => setMsg(null), 1500);
              }
            } catch {
              setMsg({
                kind: "error",
                text: "Celluloid couldn't save your profile. Check your connection and retry.",
              });
            }
          });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Email</span>
          <Input name="email" value={email} disabled className="opacity-60" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Display name</span>
          <Input
            name="display-name"
            value={value}
            maxLength={80}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={pending || value.trim() === name}
        >
          Save
        </Button>
      </form>
    </Section>
  );
}

/** Time zones offered in the preferences picker (IANA identifiers). Falls
 * back to a minimal list if the enumeration API isn't available. */
const TIME_ZONES: string[] =
  typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : ["UTC"];

function PreferencesSection({
  timeZone,
  watchRegion,
}: {
  timeZone: string;
  watchRegion: string;
}) {
  const router = useRouter();
  const [tz, setTz] = useState(timeZone);
  const [region, setRegion] = useState(watchRegion);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  // Defensive: keep the stored value selectable even if it's missing from
  // the enumerated list (e.g. a legacy alias on an older ICU build).
  const timeZoneOptions: readonly string[] = TIME_ZONES.includes(tz)
    ? TIME_ZONES
    : [tz, ...TIME_ZONES];
  const regionOptions: readonly string[] = isWatchRegion(region)
    ? WATCH_REGIONS
    : [region, ...WATCH_REGIONS];

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
                  router.refresh();
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

function RememberFiltersSection({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);

  function toggle() {
    const next = !enabled;
    setRememberFiltersEnabled(next);
    setEnabled(next);
    toast.success(
      next
        ? "Filter memory is on for this device."
        : "Filter memory is off and saved filters were cleared.",
    );
  }

  return (
    <Section
      icon={SlidersHorizontal}
      title="Remember filters on this device"
      description="Keep each page's viewing preferences between visits."
    >
      <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-2/45 p-3 ring-1 ring-line">
        <div>
          <p className="text-sm font-medium">Remember filters</p>
          <p className="mt-0.5 text-xs text-faint">
            Saves library filters and view, recommendation dials, and export scope.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Remember filters on this device"
          onClick={toggle}
          className={cn(
            "focus-ring relative h-6 w-11 shrink-0 rounded-full ring-1 transition-colors",
            enabled ? "bg-brand ring-brand" : "bg-surface ring-line-strong",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
              enabled && "translate-x-5",
            )}
          />
        </button>
      </div>
      <p className="mt-3 text-xs text-faint">
        Stored in this browser only. Search text and recommendation results are never saved.
      </p>
    </Section>
  );
}

function sortedProviderIds(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

function MyServicesSection({
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
  const router = useRouter();
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
                size={15}
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

          <div className="max-h-80 overflow-y-auto rounded-lg bg-surface-2/50 p-2 ring-1 ring-line">
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
                      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-2 ring-1 ring-line">
                        {provider.logoPath ? (
                          <Image
                            src={`${TMDB_IMAGE_BASE}w92${provider.logoPath}`}
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
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[#04121c]">
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
                  router.refresh();
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

function ApiKeySection({
  hasApiKey,
  hasServerKey,
}: {
  hasApiKey: boolean;
  hasServerKey: boolean;
}) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(hasApiKey);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Section
      icon={Sparkles}
      title="Anthropic API key"
      description="Powers your AI recommendations. Stored encrypted. You can grab one at console.anthropic.com."
    >
      <form
        method="post"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            setError(null);
            setStatus(null);
            try {
              const r = await setAnthropicKey(key);
              if (r.error) setError(r.error);
              else {
                setSaved(true);
                setKey("");
                setStatus(saved ? "API key replaced." : "API key saved.");
                router.refresh();
              }
            } catch {
              setError("Celluloid couldn't save the API key. Check your connection and retry.");
            }
          });
        }}
      >
        <p role="status" aria-live="polite" className="text-xs text-muted">
          {saved ? (
            <span className="text-emerald-300">✓ Your personal key is set.</span>
          ) : hasServerKey ? (
            "No personal key yet. Recommendations use the app's shared key and any daily limit set by its owner. Add your own to bypass that limit and use your own quota."
          ) : (
            "No key set yet. Add one to turn on AI recommendations."
          )}
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Anthropic API key</span>
          <Input
            name="anthropic-api-key"
            type="password"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setStatus(null);
            }}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {status && <Notice kind="ok">{status}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={pending || !key.trim()}
          >
            {saved ? "Replace key" : "Save key"}
          </Button>
          {saved && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  setStatus(null);
                  try {
                    const result = await removeAnthropicKey();
                    if (result?.error) {
                      setError(result.error);
                      return;
                    }
                    setSaved(false);
                    setStatus("Personal API key removed.");
                    router.refresh();
                  } catch {
                    setError("Celluloid couldn't remove the API key. Check your connection and retry.");
                  }
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      </form>
    </Section>
  );
}

function SharedLinksSection({ shares }: { shares: ShareSummary[] }) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  function copy(slug: string) {
    copyText(`${window.location.origin}/s/${slug}`, "Link copied");
  }

  async function revoke(id: string) {
    if (
      !(await confirm({
        title: "Revoke this link?",
        body: "Anyone holding the link will lose access immediately.",
        confirmLabel: "Revoke",
        destructive: true,
      }))
    )
      return;
    setPendingAction(`revoke:${id}`);
    try {
      const result = await revokeShareList(id);
      if (!result.ok) throw new Error();
      toast.success("Link revoked");
      router.refresh();
    } catch {
      toast.error("Couldn't revoke that link. Please try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function restore(id: string) {
    setPendingAction(`restore:${id}`);
    try {
      const result = await restoreShareList(id);
      if (!result.ok) throw new Error();
      toast.success("Link restored. The same URL works again.");
      router.refresh();
    } catch {
      toast.error("Couldn't restore that link. Please try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function remove(id: string, active: boolean) {
    if (
      !(await confirm({
        title: "Delete this shared link?",
        body: active
          ? "The link will stop working immediately and its record will be permanently removed."
          : "This permanently removes the link record from Settings.",
        confirmLabel: "Delete link",
        destructive: true,
      }))
    )
      return;
    setPendingAction(`delete:${id}`);
    try {
      const result = await deleteShareList(id);
      if (!result.ok) throw new Error();
      toast.success("Link deleted");
      router.refresh();
    } catch {
      toast.error("Couldn't delete that link. Please try again.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      {dialog}
      <Section
        icon={Link2}
        title="Shared links"
        description="Read-only links to your library. Revoke access without losing the record, or delete it permanently."
      >
        {shares.length === 0 ? (
          <p className="text-sm text-muted">
            No links yet. Use “Share” on the Library page to make one.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {shares.map((s) => (
              <ShareRow
                key={s.id}
                share={s}
                busy={pendingAction !== null}
                pendingAction={pendingAction}
                onCopy={() => copy(s.slug)}
                onRevoke={() => revoke(s.id)}
                onRestore={() => restore(s.id)}
                onDelete={() => remove(s.id, s.state === "ACTIVE")}
              />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

const EXPIRY_CHOICES: { value: string; label: string }[] = [
  { value: "never", label: "Never expires" },
  { value: "7", label: "7 days from now" },
  { value: "30", label: "30 days from now" },
  { value: "90", label: "90 days from now" },
];

function ShareRow({
  share: s,
  busy,
  pendingAction,
  onCopy,
  onRevoke,
  onRestore,
  onDelete,
}: {
  share: ShareSummary;
  busy: boolean;
  pendingAction: string | null;
  onCopy: () => void;
  onRevoke: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [manageOpen, setManageOpen] = useState(false);
  const [name, setName] = useState(s.name ?? "");
  const [titles, setTitles] = useState<SharedTitleSummary[] | null>(null);
  const [titlesError, setTitlesError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  // Take the server's name whenever it changes (the rename above, or another
  // tab), adjusted during render rather than by re-keying the row — a new key
  // would remount and slam the manage panel shut on every save. Same "adjusting
  // state when a prop changes" pattern the library's Trash count uses.
  const [syncedName, setSyncedName] = useState(s.name ?? "");
  if ((s.name ?? "") !== syncedName) {
    setSyncedName(s.name ?? "");
    setName(s.name ?? "");
  }

  const active = s.state === "ACTIVE";
  const stateLabel =
    s.state === "ACTIVE" ? "Live" : s.state === "EXPIRED" ? "Expired" : "Revoked";
  const expiry = s.expiresAt ? fullDate(s.expiresAt) : "Never expires";

  // The published set is only fetched when the owner actually opens the panel:
  // a whole-library share resolves the entire library, which is far too much
  // work to do for every row on every visit to Settings.
  useEffect(() => {
    if (!manageOpen || titles !== null) return;
    let cancelled = false;
    getShareListTitles(s.id)
      .then((res) => {
        if (cancelled) return;
        if (res.error || !res.titles) {
          setTitlesError(res.error ?? "Couldn't load what this link publishes.");
          return;
        }
        setTitles(res.titles);
      })
      .catch(() => {
        if (!cancelled) setTitlesError("Couldn't load what this link publishes.");
      });
    return () => {
      cancelled = true;
    };
  }, [manageOpen, titles, s.id]);

  function saveName() {
    startSaving(async () => {
      try {
        const result = await renameShareList(s.id, name);
        if (!result.ok) throw new Error();
        toast.success("Link renamed");
        router.refresh();
      } catch {
        toast.error("Couldn't rename that link. Please try again.");
      }
    });
  }

  function changeExpiry(value: string) {
    startSaving(async () => {
      try {
        const result = await setShareExpiry(
          s.id,
          value === "never" ? null : (Number(value) as 7 | 30 | 90),
        );
        if (!result.ok) throw new Error();
        toast.success(value === "never" ? "Expiry removed" : "Expiry updated");
        router.refresh();
      } catch {
        toast.error("Couldn't change the expiry. Please try again.");
      }
    });
  }

  const panelId = `share-manage-${s.id}`;

  return (
    <li className="flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{s.name ?? "Untitled list"}</p>
            <span
              className={
                active
                  ? "shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/20"
                  : "shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted ring-1 ring-line"
              }
            >
              {stateLabel}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            /s/{s.slug} · {s.count === null ? "Whole library" : `${s.count} titles`}
            {s.includeNotes ? " · notes shown" : ""}
          </p>
          <p className="mt-0.5 text-xs text-faint">
            {s.expiresAt ? `Expires ${expiry}` : expiry}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <button
            type="button"
            onClick={onCopy}
            title={active ? "Copy link" : `${stateLabel} links cannot be opened`}
            aria-label={`Copy ${s.name ?? "untitled"} share link`}
            disabled={!active || busy}
            className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
          >
            <Copy aria-hidden="true" size={15} />
          </button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={manageOpen}
            aria-controls={panelId}
            onClick={() => setManageOpen((v) => !v)}
          >
            <ChevronDown
              aria-hidden="true"
              size={14}
              className={cn("transition-transform", manageOpen && "rotate-180")}
            />
            Manage
          </Button>
          {s.state === "REVOKED" ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRestore}>
              {pendingAction === `restore:${s.id}` ? "Restoring…" : "Un-revoke"}
            </Button>
          ) : active ? (
            <Button
              variant="ghost"
              size="sm"
              aria-disabled={busy}
              className={softDisabledClass}
              onClick={() => {
                if (busy) return;
                onRevoke();
              }}
            >
              {pendingAction === `revoke:${s.id}` ? "Revoking…" : "Revoke"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className={cn("text-rose-300 hover:text-rose-200", softDisabledClass)}
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              onDelete();
            }}
          >
            {pendingAction === `delete:${s.id}` ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>

      {manageOpen && (
        <div id={panelId}>
          <Card variant="inset" className="flex flex-col gap-3 p-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Link name</span>
              <div className="flex items-center gap-2">
                <Input
                  value={name}
                  maxLength={80}
                  placeholder="Untitled list"
                  onChange={(e) => setName(e.target.value)}
                  className="min-w-0 flex-1"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={saving || busy || name.trim() === (s.name ?? "")}
                  onClick={saveName}
                >
                  Save
                </Button>
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Expiry</span>
              <Select
                value=""
                className="w-full"
                disabled={saving || busy}
                onChange={(e) => {
                  if (e.target.value) changeExpiry(e.target.value);
                }}
              >
                <option value="">Change expiry…</option>
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </Select>
              <span className="text-xs text-faint">
                Counted from now, so this also brings an expired link back.
              </span>
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">
                {s.scope === "WHOLE_LIBRARY"
                  ? "Titles this link publishes right now"
                  : "Titles this link publishes"}
              </span>
              {titlesError ? (
                <Notice kind="error">{titlesError}</Notice>
              ) : titles === null ? (
                <p className="text-xs text-muted">Loading…</p>
              ) : titles.length === 0 ? (
                <p className="text-xs text-muted">
                  Nothing. Every title this link referenced has since been removed.
                </p>
              ) : (
                <>
                  <p className="text-xs text-faint">
                    {titles.length} {titles.length === 1 ? "title" : "titles"}
                    {s.includeNotes ? ", with your notes attached" : ""}.
                  </p>
                  <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg bg-surface ring-1 ring-line">
                    {titles.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate text-foreground/90">
                          {t.name}
                        </span>
                        <span className="shrink-0 text-faint">
                          {t.mediaType === "TV" ? "TV" : "Movie"}
                          {t.year ? ` · ${t.year}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
        </div>
      )}
    </li>
  );
}

function TagsSection({ tags }: { tags: TagSummary[] }) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [deleting, setDeleting] = useState<string | null>(null);

  async function remove(tag: TagSummary) {
    if (
      !(await confirm({
        title: `Delete the “${tag.name}” tag?`,
        body:
          tag.count === 0
            ? "It isn't on any titles, so nothing else changes."
            : `It will be removed from ${tag.count} ${tag.count === 1 ? "title" : "titles"}. Those titles keep everything else.`,
        confirmLabel: "Delete tag",
        destructive: true,
      }))
    )
      return;
    setDeleting(tag.id);
    try {
      const res = await deleteTag(tag.id);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`Deleted the “${tag.name}” tag`);
      router.refresh();
    } catch {
      toast.error("Couldn't delete that tag. Try again.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <>
      {dialog}
      <Section
        icon={TagIcon}
        title="Tags"
        description="Rename a tag without losing what it's on, give it a colour, or delete it."
      >
        {tags.length === 0 ? (
          <p className="text-sm text-muted">
            No tags yet. Add one from a title page, or from the Library&apos;s
            selection bar.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {tags.map((tag) => (
              // Re-keyed on the editable fields so a refresh replaces the row's
              // draft rather than leaving an edited name over stale server data.
              <TagRow
                key={`${tag.id}:${tag.name}:${tag.color ?? ""}`}
                tag={tag}
                deleting={deleting === tag.id}
                onDelete={() => remove(tag)}
              />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function TagRow({
  tag,
  deleting,
  onDelete,
}: {
  tag: TagSummary;
  deleting: boolean;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState<string | null>(tag.color);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const dirty = name.trim() !== tag.name || color !== tag.color;

  function cancel() {
    setEditing(false);
    setName(tag.name);
    setColor(tag.color);
    setError(null);
  }

  function save() {
    start(async () => {
      setError(null);
      try {
        // Rename first: it's the change that can be refused (the name may be
        // taken), so a refusal leaves the tag exactly as it was rather than
        // half-recoloured.
        if (name.trim() !== tag.name) {
          const res = await renameTag(tag.id, name);
          if (res.error) {
            setError(res.error);
            return;
          }
        }
        if (color !== tag.color) {
          const res = await setTagColor(tag.id, color);
          if (res.error) {
            setError(res.error);
            return;
          }
        }
        setEditing(false);
        toast.success("Tag updated");
        router.refresh();
      } catch {
        setError("Couldn't update that tag. Try again.");
      }
    });
  }

  return (
    <li className="flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Badge className={tagChipClass(tag.color)}>{tag.name}</Badge>
          <span className="shrink-0 text-xs tabular-nums text-faint">
            {tag.count} {tag.count === 1 ? "title" : "titles"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={editing}
            disabled={busy || deleting}
            onClick={() => (editing ? cancel() : setEditing(true))}
          >
            <Pencil aria-hidden="true" size={14} />
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("text-rose-300 hover:text-rose-200", softDisabledClass)}
            aria-disabled={busy || deleting}
            onClick={() => {
              if (busy || deleting) return;
              onDelete();
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>

      {editing && (
        <Card variant="inset" className="flex flex-col gap-3 p-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Name</span>
            <Input
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              className="w-full"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Colour</span>
            <div role="group" aria-label="Tag colour" className="flex flex-wrap gap-1.5">
              <ColorSwatch
                label="No colour"
                swatch={TAG_COLOR_DEFAULT_SWATCH}
                selected={color === null}
                onSelect={() => setColor(null)}
              />
              {TAG_COLORS.map((c) => (
                <ColorSwatch
                  key={c}
                  label={TAG_COLOR_META[c].label}
                  swatch={TAG_COLOR_META[c].swatch}
                  selected={color === c}
                  onSelect={() => setColor(c)}
                />
              ))}
            </div>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !dirty || !name.trim()}
              onClick={save}
            >
              {busy ? <Spinner /> : null} Save
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </li>
  );
}

function ColorSwatch({
  label,
  swatch,
  selected,
  onSelect,
}: {
  label: string;
  swatch: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      className={cn(
        "focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-colors sm:min-h-9 sm:min-w-9",
        selected ? "bg-surface-2 ring-1 ring-brand/50" : "hover:bg-surface-2/60",
      )}
    >
      <span aria-hidden="true" className={cn("h-4 w-4 rounded-full ring-1", swatch)} />
    </button>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  // The field that failed the last submit. The button stays enabled so a short
  // password gets a reason on submit, not a dead button (JK-12).
  const [invalid, setInvalid] = useState<"current" | "new" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <Section icon={KeyRound} title="Password">
      <form
        method="post"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!current || next.length < 10) {
            const field = !current ? "current" : "new";
            // Render aria-invalid and the message before focus lands, so the
            // field is announced with them.
            flushSync(() => {
              setMsg(null);
              setInvalid(field);
            });
            document.getElementById(`settings-${field}-password`)?.focus();
            return;
          }
          setInvalid(null);
          start(async () => {
            setMsg(null);
            try {
              const { error } = await authClient.changePassword({
                currentPassword: current,
                newPassword: next,
                revokeOtherSessions: true,
              });
              if (error) {
                setMsg({ kind: "error", text: error.message ?? "Could not change password. Check your current password and try again." });
              } else {
                setMsg({ kind: "ok", text: "Password updated." });
                setCurrent("");
                setNext("");
              }
            } catch {
              setMsg({
                kind: "error",
                text: "Celluloid couldn't update your password. Check your connection and retry.",
              });
            }
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Current password</span>
            <Input
              id="settings-current-password"
              name="current-password"
              type="password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value);
                if (invalid === "current" && e.target.value) setInvalid(null);
              }}
              autoComplete="current-password"
              aria-invalid={invalid === "current" || undefined}
              aria-describedby={
                invalid === "current" ? "settings-current-password-error" : undefined
              }
            />
          </label>
          {invalid === "current" ? (
            // role="alert": Enter in this already-focused field moves no
            // focus, so nothing would re-read the field and its description.
            <p
              id="settings-current-password-error"
              role="alert"
              className="text-xs text-rose-300"
            >
              Enter your current password.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">New password</span>
            <Input
              id="settings-new-password"
              name="new-password"
              type="password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                if (invalid === "new" && e.target.value.length >= 10) setInvalid(null);
              }}
              autoComplete="new-password"
              aria-invalid={invalid === "new" || undefined}
              aria-describedby="settings-new-password-help"
            />
          </label>
          {/* Live for the same reason as the current-password alert; atomic so
              the whole message is read, not just the added "Too short." */}
          <p
            id="settings-new-password-help"
            aria-live="polite"
            aria-atomic="true"
            className={cn("text-xs", invalid === "new" ? "text-rose-300" : "text-faint")}
          >
            {invalid === "new" ? (next ? "Too short. " : "Enter a new password. ") : null}Use at least 10 characters.
          </p>
        </div>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={pending}
        >
          {pending ? "Updating…" : "Change password"}
        </Button>
      </form>
    </Section>
  );
}

interface DeviceSession {
  id: string;
  token: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";

  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /(?:Chrome|CriOS)\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const device = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(userAgent)
            ? "Mac"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;

  if (browser && device) return `${browser} on ${device}`;
  return browser ?? device ?? "Unknown device";
}

function sessionTimestamp(value: Date | string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function formatSessionTime(value: Date | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  // Pinned to the app's canonical en-US formatting (see lib/format's fullDate)
  // rather than the viewer's locale, so dates read the same across the app.
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function DevicesSection() {
  const { confirm, dialog } = useConfirm();
  const { data: currentSession } = authClient.useSession();
  const currentToken = currentSession?.session.token ?? null;
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadSessions() {
      setLoadError(null);
      setSessions(null);
      try {
        const { data, error } = await authClient.listSessions();
        if (cancelled) return;
        if (error) {
          setLoadError(error.message ?? "Celluloid couldn't load your devices. Try again.");
          return;
        }
        setSessions((data ?? []) as DeviceSession[]);
      } catch {
        if (!cancelled) {
          setLoadError("Celluloid couldn't load your devices. Check your connection and retry.");
        }
      }
    }

    void loadSessions();
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const orderedSessions = useMemo(
    () =>
      [...(sessions ?? [])].sort((a, b) => {
        const aCurrent = a.token === currentToken;
        const bCurrent = b.token === currentToken;
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
        return sessionTimestamp(b.updatedAt) - sessionTimestamp(a.updatedAt);
      }),
    [currentToken, sessions],
  );
  const otherSessionCount = currentToken
    ? orderedSessions.filter((session) => session.token !== currentToken).length
    : 0;
  const busy = pendingToken !== null || revokingOthers;

  async function revokeSession(session: DeviceSession) {
    const label = deviceLabel(session.userAgent);
    const accepted = await confirm({
      title: `Sign out ${label}?`,
      body: "That device will need to sign in again.",
      confirmLabel: "Sign out",
      destructive: true,
    });
    if (!accepted) return;

    setActionError(null);
    setPendingToken(session.token);
    try {
      const { error } = await authClient.revokeSession({ token: session.token });
      if (error) {
        setActionError(error.message ?? "Celluloid couldn't sign out that device. Try again.");
        return;
      }
      setSessions((current) =>
        current?.filter((item) => item.token !== session.token) ?? current,
      );
      toast.success(`${label} signed out`);
    } catch {
      setActionError("Celluloid couldn't sign out that device. Check your connection and retry.");
    } finally {
      setPendingToken(null);
    }
  }

  async function revokeOtherSessions() {
    const accepted = await confirm({
      title: "Sign out everywhere else?",
      body: `${otherSessionCount} other ${otherSessionCount === 1 ? "device" : "devices"} will need to sign in again.`,
      confirmLabel: "Sign out everywhere else",
      destructive: true,
    });
    if (!accepted) return;

    setActionError(null);
    setRevokingOthers(true);
    try {
      const { error } = await authClient.revokeOtherSessions();
      if (error) {
        setActionError(error.message ?? "Celluloid couldn't sign out your other devices. Try again.");
        return;
      }
      setSessions((current) =>
        current?.filter((session) => session.token === currentToken) ?? current,
      );
      toast.success("Other devices signed out");
    } catch {
      setActionError(
        "Celluloid couldn't sign out your other devices. Check your connection and retry.",
      );
    } finally {
      setRevokingOthers(false);
    }
  }

  return (
    <>
      {dialog}
      <Section
        icon={MonitorSmartphone}
        title="Devices"
        description="Review active sign-ins and remove devices you no longer use."
      >
        <div className="flex flex-col gap-3">
          {sessions === null && !loadError ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Loading devices…
            </p>
          ) : null}

          {loadError ? (
            <div className="flex flex-col items-start gap-3">
              <Notice kind="error">{loadError}</Notice>
              <Button variant="secondary" size="sm" onClick={() => setRetryKey((key) => key + 1)}>
                Retry
              </Button>
            </div>
          ) : null}

          {sessions && sessions.length === 0 ? (
            <p className="text-sm text-muted">No active sessions.</p>
          ) : null}

          {orderedSessions.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {orderedSessions.map((session) => {
                const label = deviceLabel(session.userAgent);
                const isCurrent = session.token === currentToken;
                return (
                  <li key={session.id}>
                    <Card
                      variant="inset"
                      className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{label}</p>
                          {isCurrent ? (
                            <Badge className="bg-brand/15 text-brand ring-brand/30">
                              Current device
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          Last active {formatSessionTime(session.updatedAt)} ·{" "}
                          {session.ipAddress ? `IP ${session.ipAddress}` : "IP unavailable"}
                        </p>
                      </div>
                      {!isCurrent ? (
                        <Button
                          variant="danger"
                          size="sm"
                          className={cn("self-start sm:self-auto", softDisabledClass)}
                          aria-label={`Sign out ${label}`}
                          aria-disabled={busy || !currentToken}
                          onClick={() => {
                            if (busy || !currentToken) return;
                            void revokeSession(session);
                          }}
                        >
                          {pendingToken === session.token ? "Signing out…" : "Sign out"}
                        </Button>
                      ) : null}
                    </Card>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {actionError ? <Notice kind="error">{actionError}</Notice> : null}

          {sessions && sessions.length > 0 ? (
            <div className="flex flex-col items-start gap-1.5 border-t border-line pt-3">
              <Button
                variant="danger"
                size="sm"
                className={softDisabledClass}
                aria-disabled={busy || !currentToken || otherSessionCount === 0}
                onClick={() => {
                  if (busy || !currentToken || otherSessionCount === 0) return;
                  void revokeOtherSessions();
                }}
              >
                {revokingOthers ? "Signing out…" : "Sign out everywhere else"}
              </Button>
              {currentToken && otherSessionCount === 0 ? (
                <p className="text-xs text-muted">No other active sessions.</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Section>
    </>
  );
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [on, setOn] = useState(enabled);
  const [phase, setPhase] = useState<"idle" | "setup">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setPassword("");
    setCode("");
    setQr(null);
    setSecret(null);
    setBackupCodes([]);
  }

  async function beginEnable() {
    setError(null);
    setBusy(true);
    try {
      const { data, error } = await authClient.twoFactor.enable({ password });
      if (error) {
        setError(error.message ?? "Couldn't start 2FA setup. Try again.");
        return;
      }
      const uri = (data as { totpURI?: string })?.totpURI;
      // qrcode is only needed for this one setup flow — load it on demand
      // instead of shipping it in the settings bundle.
      const QRCode = uri ? (await import("qrcode")).default : null;
      setQr(uri && QRCode ? await QRCode.toDataURL(uri, { margin: 1, width: 200 }) : null);
      setSecret(uri ? secretFromUri(uri) : null);
      setBackupCodes((data as { backupCodes?: string[] })?.backupCodes ?? []);
      setPhase("setup");
    } catch {
      setError("Celluloid couldn't start 2FA setup. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnable() {
    setError(null);
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code });
      if (error) {
        setError(error.message ?? "That code didn't work. Check your authenticator app and try again.");
        return;
      }
      setOn(true);
      setPhase("idle");
      reset();
      router.refresh();
    } catch {
      setError("Celluloid couldn't verify that code. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (
      !(await confirm({
        title: "Turn off two-factor authentication?",
        body: "Your account will only need a password to sign in.",
        confirmLabel: "Disable 2FA",
        destructive: true,
      }))
    )
      return;
    setError(null);
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) {
        setError(error.message ?? "Couldn't disable 2FA. Try again.");
        return;
      }
      setOn(false);
      reset();
      router.refresh();
    } catch {
      setError("Celluloid couldn't disable 2FA. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {dialog}
      <Section
      icon={ShieldCheck}
      title="Two-factor authentication"
      description="Ask for a code from your authenticator app each time you sign in."
    >
      {on ? (
        <form
          method="post"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !password) return;
            void disable();
          }}
        >
          <p role="status" className="text-sm text-emerald-300">
            ✓ Two-factor authentication is on.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              Current password to disable 2FA
            </span>
            <Input
              name="disable-two-factor-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <Notice kind="error">{error}</Notice>}
          <Button
            type="submit"
            variant="danger"
            size="sm"
            className={cn("self-start", softDisabledClass)}
            aria-disabled={busy || !password}
          >
            {busy ? <Spinner /> : null} Disable 2FA
          </Button>
        </form>
      ) : phase === "idle" ? (
        <form
          method="post"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void beginEnable();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              Current password to enable 2FA
            </span>
            <Input
              name="enable-two-factor-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <Notice kind="error">{error}</Notice>}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="self-start"
            disabled={busy || !password}
          >
            {busy ? <Spinner /> : <ShieldCheck size={15} />} Enable 2FA
          </Button>
        </form>
      ) : (
        <form
          method="post"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void confirmEnable();
          }}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt="Scan to set up two-factor authentication"
                width={180}
                height={180}
                className="shrink-0 rounded-lg bg-white p-2"
              />
            )}
            <div className="flex flex-col gap-3 text-sm text-muted">
              <p>
                1. Scan this QR code with your authenticator app (Google
                Authenticator, Authy, 1Password, and so on).
              </p>
              {secret && (
                <div>
                  <p>Can&apos;t scan it? Type this setup key in by hand instead:</p>
                  <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-line">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs tracking-wider text-foreground/90">
                      {groupSecret(secret)}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyText(secret, "Setup key copied")}
                      className="focus-ring flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
                    >
                      <Copy size={13} /> Copy
                    </button>
                  </div>
                </div>
              )}
              <div>
                <div className="flex items-center justify-between gap-2">
                  <p>2. Keep these backup codes somewhere safe.</p>
                  {backupCodes.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        copyText(backupCodes.join("\n"), "Backup codes copied")
                      }
                      className="focus-ring rounded flex shrink-0 items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
                    >
                      <Copy size={12} /> Copy all
                    </button>
                  )}
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-foreground/90">
                  {backupCodes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">
                3. Enter the 6-digit code from your app to finish.
              </span>
              <Input
                name="two-factor-verification-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="w-40 tracking-widest"
              />
            </label>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || code.length < 6}
            >
              {busy ? <Spinner /> : null} Verify & turn on
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setPhase("idle");
                reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      </Section>
    </>
  );
}

type RestorePreview = {
  create: number;
  update: number;
  skip: number;
  conflict: number;
  suppressionsCreate: number;
  suppressionsUpdate: number;
  suppressionsSkip: number;
  providerSelections: number;
  providerPreferenceIncluded: number;
  providerPreferenceUpdate: number;
  recommendModelPreferenceIncluded: number;
  recommendModelPreferenceUpdate: number;
  confirmationToken: string;
};

type RestoreResult = Omit<RestorePreview, "confirmationToken"> & {
  sharesCreated: number;
  sharesSkipped: number;
  eventsCreated: number;
  eventsSkipped: number;
};

/** A backup older than this is called out. One month of watches is a real loss. */
const STALE_BACKUP_DAYS = 30;

/**
 * How stale the off-site copy is. `ageDays` is measured on the server rather
 * than here: "now" would otherwise be read at two different instants (the
 * server render and hydration), and a day boundary falling between them would
 * be a mismatch on the one line whose whole job is to be trustworthy.
 */
function BackupFreshness({
  lastBackupAt,
  ageDays,
}: {
  lastBackupAt: string | null;
  ageDays: number | null;
}) {
  if (!lastBackupAt || ageDays === null) {
    return (
      <p role="status" className="text-xs text-amber-200">
        No backup downloaded yet. This file is the only copy of your history that
        lives outside the app.
      </p>
    );
  }

  const relative =
    ageDays <= 0 ? "today" : ageDays === 1 ? "yesterday" : `${ageDays} days ago`;
  const stale = ageDays >= STALE_BACKUP_DAYS;

  return (
    <p role="status" className={cn("text-xs", stale ? "text-amber-200" : "text-muted")}>
      Last backup {fullDate(lastBackupAt)} ({relative}).
      {stale
        ? " Anything you have watched, rated or noted since then isn't in it."
        : ""}
    </p>
  );
}

function BackupSection({
  lastBackupAt,
  backupAgeDays,
}: {
  lastBackupAt: string | null;
  backupAgeDays: number | null;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"merge" | "replace-personal">("merge");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"download" | "preview" | "restore" | null>(null);

  function resetPreview() {
    setPreview(null);
    setResult(null);
    setError(null);
  }

  async function downloadBackup() {
    setBusy("download");
    setError(null);
    try {
      const response = await fetch("/api/backup", { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error || "Celluloid couldn't create the backup. Try again.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ?? "celluloid-backup.json";
      saveBlob(blob, filename);
      toast.success("Backup downloaded");
      // Pull the freshness line back from the server, which has just stamped it.
      router.refresh();
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Celluloid couldn't create the backup. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function sendRestore(dryRun: boolean, confirmationToken?: string) {
    if (!file) throw new Error("Choose a backup file first.");
    const form = new FormData();
    form.set("file", file);
    form.set("mode", mode);
    form.set("dryRun", String(dryRun));
    if (confirmationToken) form.set("confirmationToken", confirmationToken);

    const response = await fetch("/api/backup/restore", {
      method: "POST",
      body: form,
    });
    const body = (await response.json().catch(() => null)) as
      | (Partial<RestorePreview & RestoreResult> & { error?: string })
      | null;
    if (!response.ok || !body) {
      throw new Error(
        body?.error || "Celluloid couldn't read that backup. Check the file and try again.",
      );
    }
    return body;
  }

  async function previewRestore() {
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const body = await sendRestore(true);
      if (
        typeof body.create !== "number" ||
        typeof body.update !== "number" ||
        typeof body.skip !== "number" ||
        typeof body.conflict !== "number" ||
        typeof body.suppressionsCreate !== "number" ||
        typeof body.suppressionsUpdate !== "number" ||
        typeof body.suppressionsSkip !== "number" ||
        typeof body.providerSelections !== "number" ||
        typeof body.providerPreferenceIncluded !== "number" ||
        typeof body.providerPreferenceUpdate !== "number" ||
        typeof body.recommendModelPreferenceIncluded !== "number" ||
        typeof body.recommendModelPreferenceUpdate !== "number" ||
        typeof body.confirmationToken !== "string"
      ) {
        throw new Error("Celluloid returned an incomplete restore preview. Try again.");
      }
      setPreview({
        create: body.create,
        update: body.update,
        skip: body.skip,
        conflict: body.conflict,
        suppressionsCreate: body.suppressionsCreate,
        suppressionsUpdate: body.suppressionsUpdate,
        suppressionsSkip: body.suppressionsSkip,
        providerSelections: body.providerSelections,
        providerPreferenceIncluded: body.providerPreferenceIncluded,
        providerPreferenceUpdate: body.providerPreferenceUpdate,
        recommendModelPreferenceIncluded: body.recommendModelPreferenceIncluded,
        recommendModelPreferenceUpdate: body.recommendModelPreferenceUpdate,
        confirmationToken: body.confirmationToken,
      });
    } catch (previewError) {
      setPreview(null);
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Celluloid couldn't preview that backup. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function commitRestore() {
    if (!preview) return;
    const hiddenSuggestionWrites =
      preview.suppressionsCreate + preview.suppressionsUpdate;
    const providerCopy = !preview.providerPreferenceIncluded
      ? "This older file has no selected-service data."
      : preview.providerPreferenceUpdate
        ? `It will restore ${preview.providerSelections} selected ${preview.providerSelections === 1 ? "service" : "services"}.`
        : "The current selected services will stay unchanged.";
    const recommendModelCopy = !preview.recommendModelPreferenceIncluded
      ? "It has no recommendation-model preference."
      : preview.recommendModelPreferenceUpdate
        ? "It will restore the recommendation-model preference."
        : "The current recommendation model will stay unchanged.";
    const approved = await confirm({
      title: "Restore this backup?",
      body: `This will create ${preview.create} and update ${preview.update} titles, and restore ${hiddenSuggestionWrites} hidden ${hiddenSuggestionWrites === 1 ? "suggestion" : "suggestions"}. ${providerCopy} ${recommendModelCopy} Existing titles not included in the backup stay untouched. Restored shared lists receive new private links.`,
      confirmLabel: "Restore backup",
      destructive: mode === "replace-personal",
    });
    if (!approved) return;

    setBusy("restore");
    setError(null);
    try {
      const body = await sendRestore(false, preview.confirmationToken);
      if (
        typeof body.create !== "number" ||
        typeof body.update !== "number" ||
        typeof body.skip !== "number" ||
        typeof body.conflict !== "number" ||
        typeof body.suppressionsCreate !== "number" ||
        typeof body.suppressionsUpdate !== "number" ||
        typeof body.suppressionsSkip !== "number" ||
        typeof body.providerSelections !== "number" ||
        typeof body.providerPreferenceIncluded !== "number" ||
        typeof body.providerPreferenceUpdate !== "number" ||
        typeof body.recommendModelPreferenceIncluded !== "number" ||
        typeof body.recommendModelPreferenceUpdate !== "number" ||
        typeof body.sharesCreated !== "number" ||
        typeof body.sharesSkipped !== "number" ||
        typeof body.eventsCreated !== "number" ||
        typeof body.eventsSkipped !== "number"
      ) {
        throw new Error("Celluloid returned an incomplete restore result. Refresh and check your library.");
      }
      setResult({
        create: body.create,
        update: body.update,
        skip: body.skip,
        conflict: body.conflict,
        suppressionsCreate: body.suppressionsCreate,
        suppressionsUpdate: body.suppressionsUpdate,
        suppressionsSkip: body.suppressionsSkip,
        providerSelections: body.providerSelections,
        providerPreferenceIncluded: body.providerPreferenceIncluded,
        providerPreferenceUpdate: body.providerPreferenceUpdate,
        recommendModelPreferenceIncluded: body.recommendModelPreferenceIncluded,
        recommendModelPreferenceUpdate: body.recommendModelPreferenceUpdate,
        sharesCreated: body.sharesCreated,
        sharesSkipped: body.sharesSkipped,
        eventsCreated: body.eventsCreated,
        eventsSkipped: body.eventsSkipped,
      });
      setPreview(null);
      toast.success("Backup restored");
      router.refresh();
    } catch (restoreError) {
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : "Celluloid couldn't restore that backup. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {dialog}
      <Section
        icon={ArchiveRestore}
        title="Backup"
        description="Download a current v2 copy, or restore a Celluloid v1 or v2 backup."
      >
        <div className="flex flex-col gap-4">
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={downloadBackup}
            >
              {busy === "download" ? <Spinner /> : <Download aria-hidden="true" size={15} />}
              {busy === "download" ? "Preparing backup\u2026" : "Download backup"}
            </Button>
            <div className="mt-2">
              <BackupFreshness lastBackupAt={lastBackupAt} ageDays={backupAgeDays} />
            </div>
            <p className="mt-2 text-xs text-muted">
              Includes active and trashed titles, watch history, ratings, notes, tags, TV
              progress, selected services, recommendation preferences, hidden suggestions,
              and share settings. Passwords, sessions, API keys, 2FA secrets, and live share
              URLs are excluded.
            </p>
          </div>

          <div className="border-t border-line pt-4">
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">Backup file</span>
                <Input
                  name="celluloid-backup"
                  type="file"
                  accept="application/json,.json"
                  className="h-auto min-h-11 py-2 file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-2 file:py-1 file:text-xs file:font-medium file:text-foreground"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    resetPreview();
                  }}
                />
              </label>
              <p className="text-xs text-faint">Celluloid v1 or v2 JSON, up to 4 MB.</p>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">Restore mode</span>
                <Select
                  name="backup-restore-mode"
                  value={mode}
                  className="w-full"
                  onChange={(event) => {
                    setMode(event.target.value as "merge" | "replace-personal");
                    resetPreview();
                  }}
                >
                  <option value="merge">Merge without replacing personal data</option>
                  <option value="replace-personal">Use backup personal data</option>
                </Select>
              </label>
              <p className="text-xs text-muted">
                {mode === "merge"
                  ? "Merge adds missing titles and fills empty ratings, notes, and dates. Current status, favorites, progress, and existing tags stay in place."
                  : "The backup replaces status, ratings, notes, dates, favorites, tags, and episode progress for matching titles. Other titles stay in place."}
              </p>

              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="self-start"
                disabled={!file || busy !== null}
                onClick={previewRestore}
              >
                {busy === "preview" ? <Spinner /> : <Upload aria-hidden="true" size={15} />}
                {busy === "preview" ? "Checking backup\u2026" : "Preview restore"}
              </Button>
            </div>
          </div>

          {preview ? (
            <div className="rounded-lg bg-surface-2 p-3 ring-1 ring-line" aria-live="polite">
              <p className="text-xs font-medium text-foreground">Restore preview</p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs tabular-nums">
                <div>
                  <dt className="text-muted">Create</dt>
                  <dd className="font-medium">{preview.create}</dd>
                </div>
                <div>
                  <dt className="text-muted">Update</dt>
                  <dd className="font-medium">{preview.update}</dd>
                </div>
                <div>
                  <dt className="text-muted">Unchanged</dt>
                  <dd className="font-medium">{preview.skip}</dd>
                </div>
                <div>
                  <dt className="text-muted">Conflicts</dt>
                  <dd className="font-medium text-amber-300">{preview.conflict}</dd>
                </div>
                <div>
                  <dt className="text-muted">Hidden suggestions</dt>
                  <dd className="font-medium">
                    {preview.suppressionsCreate + preview.suppressionsUpdate}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Already hidden</dt>
                  <dd className="font-medium">{preview.suppressionsSkip}</dd>
                </div>
                <div>
                  <dt className="text-muted">Selected services</dt>
                  <dd className="font-medium">
                    {preview.providerPreferenceIncluded
                      ? `${preview.providerSelections} · ${preview.providerPreferenceUpdate ? "Restore" : "Keep current"}`
                      : "Not in file"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Recommendation model</dt>
                  <dd className="font-medium">
                    {preview.recommendModelPreferenceIncluded
                      ? preview.recommendModelPreferenceUpdate
                        ? "Restore"
                        : "Keep current"
                      : "Not in file"}
                  </dd>
                </div>
              </dl>
              {preview.conflict > 0 ? (
                <p className="mt-2 text-xs text-amber-200">
                  Conflicting titles are skipped. The rest can still be restored.
                </p>
              ) : null}
              <Button
                type="button"
                variant={mode === "replace-personal" ? "danger" : "primary"}
                size="sm"
                className={cn("mt-3", softDisabledClass)}
                aria-disabled={busy !== null}
                onClick={() => {
                  if (busy !== null) return;
                  void commitRestore();
                }}
              >
                {busy === "restore" ? <Spinner /> : <ArchiveRestore aria-hidden="true" size={15} />}
                {busy === "restore" ? "Restoring\u2026" : "Restore backup"}
              </Button>
            </div>
          ) : null}

          {result ? (
            <Notice kind="ok">
              Restored {result.create} new and {result.update} existing titles. Skipped {result.skip}
              {result.conflict > 0 ? `, with ${result.conflict} conflicts` : ""}. Created {result.sharesCreated}
              {result.sharesCreated === 1 ? " share link" : " share links"}.
              {result.sharesSkipped > 0
                ? ` Recognized ${result.sharesSkipped} already-restored share ${result.sharesSkipped === 1 ? "link" : "links"}.`
                : ""}
              {" "}Restored {result.eventsCreated} watch
              {result.eventsCreated === 1 ? " event" : " events"}.
              {result.eventsSkipped > 0
                ? ` Recognized ${result.eventsSkipped} already-restored watch ${result.eventsSkipped === 1 ? "event" : "events"}.`
                : ""}
              {" "}Restored {result.suppressionsCreate + result.suppressionsUpdate} hidden
              {result.suppressionsCreate + result.suppressionsUpdate === 1 ? " suggestion" : " suggestions"}.
              {result.suppressionsSkip > 0
                ? ` Recognized ${result.suppressionsSkip} already-recorded hidden ${result.suppressionsSkip === 1 ? "suggestion" : "suggestions"}.`
                : ""}
              {result.providerPreferenceIncluded
                ? result.providerPreferenceUpdate
                  ? ` Restored ${result.providerSelections} selected ${result.providerSelections === 1 ? "service" : "services"}.`
                  : " Kept the current selected services."
                : ""}
              {result.recommendModelPreferenceIncluded
                ? result.recommendModelPreferenceUpdate
                  ? " Restored the recommendation-model preference."
                  : " Kept the current recommendation model."
                : ""}
            </Notice>
          ) : null}
          {error ? <Notice kind="error">{error}</Notice> : null}
        </div>
      </Section>
    </>
  );
}

function DangerSection() {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <>
      {dialog}
      <Section
      icon={Trash2}
      title="Delete account"
      description="This wipes your account and everything in it. There's no undo."
    >
      <form
        method="post"
        className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending || !password) return;
          if (
            !(await confirm({
              title: "Delete your account?",
              body: "This permanently deletes your account and everything in it. This can't be undone.",
              confirmLabel: "Delete account",
              destructive: true,
            }))
          )
            return;
          start(async () => {
            setError(null);
            // The auth boundary requires and verifies this password even for
            // a fresh session, so a session cookie alone cannot delete data.
            const { error } = await authClient.deleteUser({ password });
            if (error) {
              setError(error.message ?? "Couldn't delete the account. Try again.");
              return;
            }
            router.push("/login");
            router.refresh();
          });
        }}
      >
        <p className="text-sm font-medium text-foreground/90">
          Deleting your account removes:
        </p>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-muted marker:text-rose-400/60">
          <li>Your whole library and watch history</li>
          <li>Every tag, note, and rating you&apos;ve added</li>
          <li>Your shared links and saved API key</li>
        </ul>
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">
            Enter your password to confirm it&apos;s you
          </span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="Current password"
          />
        </label>
        {error && <div className="mt-3"><Notice kind="error">{error}</Notice></div>}
        <Button
          type="submit"
          variant="danger"
          size="sm"
          className={cn("mt-4", softDisabledClass)}
          aria-disabled={pending || !password}
        >
          <Trash2 size={15} /> Delete my account
        </Button>
      </form>
      </Section>
    </>
  );
}

// TMDB's terms put the attribution in an "About" or "Credits" type section.
function AboutSection() {
  return (
    <Section icon={Info} title="About" description="Where Celluloid's data comes from.">
      <div className="flex flex-col gap-3">
        <TmdbAttribution />
        <p className="text-xs text-faint">Streaming availability via JustWatch.</p>
      </div>
    </Section>
  );
}
