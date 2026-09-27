"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  Download,
  KeyRound,
  MonitorSmartphone,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { AccountInfo, ShareSummary } from "@/lib/data";
import { authClient } from "@/lib/auth-client";
import { Badge, Button, Card, Input, Spinner, softDisabledClass } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { saveBlob } from "@/lib/save-blob";
import { Notice, Section, copyText } from "./settings-ui";
import { ProfileSection } from "./profile-section";
import { PreferencesSection } from "./preferences-section";
import { MyServicesSection, type ProviderOption } from "./my-services-section";
import { RememberFiltersSection } from "./remember-filters-section";
import { ApiKeySection } from "./api-key-section";
import { SharedLinksSection } from "./shared-links-section";
import { TagsSection, type TagSummary } from "./tags-section";
import {
  MetadataSyncSection,
  type MetadataFailureSummary,
} from "./metadata-sync-section";
import { BackupSection } from "./backup-section";
import { AboutSection } from "./about-section";

export type { MetadataFailureSummary, ProviderOption, TagSummary };

export function SettingsClient({
  info,
  shares,
  tags,
  timeZone,
  watchRegion,
  watchRegions,
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
  /** TMDB's streaming regions, sorted by name. */
  watchRegions: string[];
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
      <PreferencesSection
        timeZone={timeZone}
        watchRegion={watchRegion}
        watchRegions={watchRegions}
      />
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
        {/* Turning 2FA on or off replaces this device's session, and turning
            it on signs out the others, so reload the list when it flips. */}
        <DevicesSection key={info.twoFactorEnabled ? "2fa-on" : "2fa-off"} />
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
          if (pending) return;
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
      // The row, and the Sign out button that had focus, are gone.
      document.getElementById("settings-devices-heading")?.focus();
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
        headingId="settings-devices-heading"
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
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [codesPassword, setCodesPassword] = useState("");
  const [codesError, setCodesError] = useState<string | null>(null);
  const [codesBusy, setCodesBusy] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  function reset() {
    setPassword("");
    setCode("");
    setQr(null);
    setSecret(null);
    setBackupCodes([]);
    setRevokeError(null);
    setCodesPassword("");
    setCodesError(null);
    setNewCodes(null);
  }

  async function regenerateBackupCodes() {
    setCodesError(null);
    setCodesBusy(true);
    try {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({
        password: codesPassword,
      });
      if (error) {
        setCodesError(error.message ?? "Couldn't make new backup codes. Try again.");
        return;
      }
      setCodesPassword("");
      // The form, and the button that had focus, give way to the codes.
      flushSync(() => setNewCodes(data.backupCodes));
      document.getElementById("settings-new-backup-codes")?.focus();
    } catch {
      setCodesError("Celluloid couldn't make new backup codes. Check your connection and retry.");
    } finally {
      setCodesBusy(false);
    }
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
      const qrDataUrl =
        uri && QRCode ? await QRCode.toDataURL(uri, { margin: 1, width: 200 }) : null;
      // The password form, and the Turn on 2FA button that had focus, give way
      // to the setup steps. Start at step 1 so the QR code, setup key and
      // backup codes come before the code field.
      flushSync(() => {
        setQr(qrDataUrl);
        setSecret(uri ? secretFromUri(uri) : null);
        setBackupCodes((data as { backupCodes?: string[] })?.backupCodes ?? []);
        setPhase("setup");
      });
      document.getElementById("settings-two-factor-setup-start")?.focus();
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
      // A session stolen before 2FA was on would otherwise keep working, so
      // sign out every other device, as a password change does. verifyTotp
      // has already replaced this device's session; the new one is kept.
      const signedOutOthers = await authClient.revokeOtherSessions().then(
        (result) => !result.error,
        () => false,
      );
      // The setup form, and the Verify button that had focus, give way to the
      // "on" panel.
      flushSync(() => {
        setOn(true);
        setPhase("idle");
        reset();
      });
      document.getElementById("settings-two-factor-on")?.focus();
      if (signedOutOthers) {
        toast.success("Two-factor authentication is on. Other devices were signed out.");
      } else {
        setRevokeError(
          "Two-factor authentication is on, but Celluloid couldn't sign out your other devices. Use Sign out everywhere else under Devices.",
        );
      }
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
        confirmLabel: "Turn off 2FA",
        destructive: true,
      }))
    )
      return;
    setError(null);
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) {
        setError(error.message ?? "Couldn't turn off 2FA. Try again.");
        return;
      }
      // The panel, and the Turn off 2FA button that had focus, give way to the
      // form that turns it back on.
      flushSync(() => {
        setOn(false);
        reset();
      });
      document.getElementById("settings-enable-two-factor-password")?.focus();
      router.refresh();
    } catch {
      setError("Celluloid couldn't turn off 2FA. Check your connection and retry.");
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
        <div className="flex flex-col gap-4">
          <p
            id="settings-two-factor-on"
            tabIndex={-1}
            role="status"
            className="text-sm text-emerald-300 outline-none"
          >
            ✓ Two-factor authentication is on.
          </p>
          {revokeError && <Notice kind="error">{revokeError}</Notice>}
          {newCodes ? (
            <div className="flex flex-col gap-3">
              <p
                id="settings-new-backup-codes"
                tabIndex={-1}
                className="text-sm text-muted outline-none"
              >
                Your new backup codes. Save them now: they won&apos;t be shown again, and
                your old codes no longer work.
              </p>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => copyText(newCodes.join("\n"), "Backup codes copied")}
                  className="focus-ring rounded flex shrink-0 items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
                >
                  <Copy size={12} /> Copy all
                </button>
                <button
                  type="button"
                  onClick={() =>
                    saveBlob(
                      new Blob([`${newCodes.join("\n")}\n`], { type: "text/plain" }),
                      "celluloid-backup-codes.txt",
                    )
                  }
                  className="focus-ring rounded flex shrink-0 items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
                >
                  <Download size={12} /> Download
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-foreground/90">
                {newCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => {
                  flushSync(() => setNewCodes(null));
                  document.getElementById("settings-regenerate-backup-codes")?.focus();
                }}
              >
                Done
              </Button>
            </div>
          ) : (
            <form
              method="post"
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (codesBusy || !codesPassword) return;
                void regenerateBackupCodes();
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">
                  Current password to regenerate backup codes
                </span>
                <Input
                  name="regenerate-backup-codes-password"
                  type="password"
                  value={codesPassword}
                  onChange={(e) => setCodesPassword(e.target.value)}
                  autoComplete="current-password"
                  aria-describedby="settings-regenerate-backup-codes-help"
                />
              </label>
              <p id="settings-regenerate-backup-codes-help" className="text-xs text-faint">
                Get a new set if you&apos;ve used or lost yours. Your old codes stop working.
              </p>
              {codesError && <Notice kind="error">{codesError}</Notice>}
              <Button
                id="settings-regenerate-backup-codes"
                type="submit"
                variant="secondary"
                size="sm"
                className={cn("self-start", softDisabledClass)}
                aria-disabled={codesBusy || !codesPassword}
              >
                {codesBusy ? <Spinner /> : null} Regenerate backup codes
              </Button>
            </form>
          )}
          <form
            method="post"
            className="flex flex-col gap-3 border-t border-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || !password) return;
              void disable();
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">
                Current password to turn off 2FA
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
              {busy ? <Spinner /> : null} Turn off 2FA
            </Button>
          </form>
        </div>
      ) : phase === "idle" ? (
        <form
          method="post"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !password) return;
            void beginEnable();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              Current password to turn on 2FA
            </span>
            <Input
              id="settings-enable-two-factor-password"
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
            {busy ? <Spinner /> : <ShieldCheck size={16} />} Turn on 2FA
          </Button>
        </form>
      ) : (
        <form
          method="post"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || code.length < 6) return;
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
              <p id="settings-two-factor-setup-start" tabIndex={-1} className="outline-none">
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
          <Trash2 size={16} /> Delete my account
        </Button>
      </form>
      </Section>
    </>
  );
}
