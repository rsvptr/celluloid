"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Download, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, Input, Spinner, softDisabledClass } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { saveBlob } from "@/lib/save-blob";
import { Notice, Section, copyText } from "./settings-ui";

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

export function TwoFactorSection({ enabled }: { enabled: boolean }) {
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
