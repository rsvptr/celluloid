"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArchiveRestore,
  Copy,
  Download,
  Globe,
  KeyRound,
  Link2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import type { AccountInfo, ShareSummary } from "@/lib/data";
import { authClient } from "@/lib/auth-client";
import { Button, Card, Input, Select, Spinner } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import {
  removeAnthropicKey,
  setAnthropicKey,
  updatePreferences,
  updateProfile,
} from "@/lib/settings-actions";
import { deleteShareList, revokeShareList } from "@/lib/share-actions";
import { isWatchRegion, regionName, WATCH_REGIONS } from "@/lib/tmdb-extras";

export function SettingsClient({
  info,
  shares,
  timeZone,
  watchRegion,
}: {
  info: AccountInfo;
  shares: ShareSummary[];
  timeZone: string;
  watchRegion: string;
}) {
  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-2">
      <ProfileSection name={info.name} email={info.email} />
      <PreferencesSection timeZone={timeZone} watchRegion={watchRegion} />
      <ApiKeySection hasApiKey={info.hasApiKey} hasServerKey={info.hasServerKey} />
      <SharedLinksSection shares={shares} />
      <TwoFactorSection enabled={info.twoFactorEnabled} />
      <PasswordSection />
      <BackupSection />
      <DangerSection />
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
      <div className="flex flex-col gap-3">
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
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={pending || value.trim() === name}
          onClick={() =>
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
            })
          }
        >
          Save
        </Button>
      </div>
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
      <div className="flex flex-col gap-3">
        <p role="status" aria-live="polite" className="text-xs text-muted">
          {saved ? (
            <span className="text-emerald-300">✓ Your personal key is set.</span>
          ) : hasServerKey ? (
            "No personal key yet. Recommendations run on the app's shared key, so add your own to use your own quota."
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
            variant="primary"
            size="sm"
            disabled={pending || !key.trim()}
            onClick={() =>
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
              })
            }
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
      </div>
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
            {shares.map((s) => {
              const active = s.state === "ACTIVE";
              const expiry = s.expiresAt
                ? new Intl.DateTimeFormat("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    timeZone: "UTC",
                  }).format(new Date(s.expiresAt))
                : "Never expires";
              const stateLabel =
                s.state === "ACTIVE"
                  ? "Live"
                  : s.state === "EXPIRED"
                    ? "Expired"
                    : "Revoked";
              return (
                <li
                  key={s.id}
                  className="flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {s.name ?? "Untitled list"}
                      </p>
                      <span
                        className={
                          s.state === "ACTIVE"
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
                  <div className="flex shrink-0 items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => copy(s.slug)}
                      title={active ? "Copy link" : `${stateLabel} links cannot be opened`}
                      aria-label={`Copy ${s.name ?? "untitled"} share link`}
                      disabled={!active || pendingAction !== null}
                      className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                    >
                      <Copy aria-hidden="true" size={15} />
                    </button>
                    {active ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pendingAction !== null}
                        onClick={() => revoke(s.id)}
                      >
                        {pendingAction === `revoke:${s.id}` ? "Revoking…" : "Revoke"}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-rose-300 hover:text-rose-200"
                      disabled={pendingAction !== null}
                      onClick={() => remove(s.id, active)}
                    >
                      {pendingAction === `delete:${s.id}` ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <Section icon={KeyRound} title="Password">
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Current password</span>
          <Input
            name="current-password"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">New password</span>
          <Input
            name="new-password"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            placeholder="At least 10 characters"
          />
        </label>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={pending || !current || next.length < 10}
          onClick={() =>
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
            })
          }
        >
          {pending ? "Updating…" : "Change password"}
        </Button>
      </div>
    </Section>
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
        <div className="flex flex-col gap-3">
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
            variant="danger"
            size="sm"
            className="self-start"
            disabled={busy || !password}
            onClick={disable}
          >
            {busy ? <Spinner /> : null} Disable 2FA
          </Button>
        </div>
      ) : phase === "idle" ? (
        <div className="flex flex-col gap-3">
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
            variant="primary"
            size="sm"
            className="self-start"
            disabled={busy || !password}
            onClick={beginEnable}
          >
            {busy ? <Spinner /> : <ShieldCheck size={15} />} Enable 2FA
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
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
              variant="primary"
              size="sm"
              disabled={busy || code.length < 6}
              onClick={confirmEnable}
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
        </div>
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
  confirmationToken: string;
};

type RestoreResult = Omit<RestorePreview, "confirmationToken"> & {
  sharesCreated: number;
  sharesSkipped: number;
  eventsCreated: number;
  eventsSkipped: number;
};

function BackupSection() {
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
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Backup downloaded");
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
        typeof body.confirmationToken !== "string"
      ) {
        throw new Error("Celluloid returned an incomplete restore preview. Try again.");
      }
      setPreview({
        create: body.create,
        update: body.update,
        skip: body.skip,
        conflict: body.conflict,
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
    const approved = await confirm({
      title: "Restore this backup?",
      body: `This will create ${preview.create} and update ${preview.update} titles. Existing titles not included in the backup stay untouched. Restored shared lists receive new private links.`,
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
            <p className="mt-2 text-xs text-muted">
              Includes active and trashed titles, watch history, ratings, notes, tags, TV
              progress, preferences, and share settings. Passwords, sessions, API keys, 2FA
              secrets, and live share URLs are excluded.
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
                <div><dt className="text-muted">Create</dt><dd className="font-medium">{preview.create}</dd></div>
                <div><dt className="text-muted">Update</dt><dd className="font-medium">{preview.update}</dd></div>
                <div><dt className="text-muted">Unchanged</dt><dd className="font-medium">{preview.skip}</dd></div>
                <div><dt className="text-muted">Conflicts</dt><dd className="font-medium text-amber-300">{preview.conflict}</dd></div>
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
                className="mt-3"
                disabled={busy !== null}
                onClick={commitRestore}
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
      <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-4">
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
          variant="danger"
          size="sm"
          className="mt-4"
          disabled={pending || !password}
          onClick={async () => {
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
              // Better Auth verifies the password server-side before deleting,
              // so a hijacked session alone can't destroy the account.
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
          <Trash2 size={15} /> Delete my account
        </Button>
      </div>
      </Section>
    </>
  );
}
