"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { toast } from "sonner";
import {
  Copy,
  KeyRound,
  Link2,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import type { AccountInfo, ShareSummary } from "@/lib/data";
import { authClient } from "@/lib/auth-client";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import {
  removeAnthropicKey,
  setAnthropicKey,
  updateProfile,
} from "@/lib/settings-actions";
import { deleteShareList } from "@/lib/share-actions";

export function SettingsClient({
  info,
  shares,
}: {
  info: AccountInfo;
  shares: ShareSummary[];
}) {
  return (
    <div className="flex flex-col gap-5">
      <ProfileSection name={info.name} email={info.email} />
      <ApiKeySection hasApiKey={info.hasApiKey} hasServerKey={info.hasServerKey} />
      <SharedLinksSection shares={shares} />
      <TwoFactorSection enabled={info.twoFactorEnabled} />
      <PasswordSection />
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
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 text-brand">
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

function Notice({ kind, children }: { kind: "ok" | "error"; children: React.ReactNode }) {
  return (
    <p
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
          <Input value={email} disabled className="opacity-60" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Display name</span>
          <Input
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
              const r = await updateProfile(value);
              if (r.error) {
                setMsg({ kind: "error", text: r.error });
              } else {
                setMsg({ kind: "ok", text: "Saved." });
                router.refresh();
                setTimeout(() => setMsg(null), 1500);
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
  const [pending, start] = useTransition();

  return (
    <Section
      icon={Sparkles}
      title="Anthropic API key"
      description="Powers your AI recommendations. Stored encrypted. You can grab one at console.anthropic.com."
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          {saved ? (
            <span className="text-emerald-300">✓ Your personal key is set.</span>
          ) : hasServerKey ? (
            "No personal key yet. Recommendations run on the app's shared key, so add your own to use your own quota."
          ) : (
            "No key set yet. Add one to turn on AI recommendations."
          )}
        </p>
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-..."
          autoComplete="off"
        />
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={pending || !key.trim()}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await setAnthropicKey(key);
                if (r.error) setError(r.error);
                else {
                  setSaved(true);
                  setKey("");
                  router.refresh();
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
                  await removeAnthropicKey();
                  setSaved(false);
                  router.refresh();
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
  const [pendingId, setPendingId] = useState<string | null>(null);

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
    setPendingId(id);
    deleteShareList(id)
      .then(() => {
        toast.success("Link revoked");
        router.refresh();
      })
      .catch(() => toast.error("Couldn't revoke that link. Please try again."))
      .finally(() => setPendingId(null));
  }

  return (
    <>
      {dialog}
      <Section
      icon={Link2}
      title="Shared links"
      description="Read-only links to your library that anyone can open. Revoke any you don't want live anymore."
    >
      {shares.length === 0 ? (
        <p className="text-sm text-muted">
          No links yet. Use “Share” on the Library page to make one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {shares.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {s.name ?? "Untitled list"}
                </p>
                <p className="truncate text-xs text-muted">
                  /s/{s.slug} · {s.count === null ? "Whole library" : `${s.count} titles`}
                  {s.includeNotes ? " · notes shown" : ""}
                </p>
              </div>
              <button
                onClick={() => copy(s.slug)}
                title="Copy link"
                aria-label="Copy share link"
                className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground"
              >
                <Copy size={15} />
              </button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pendingId === s.id}
                onClick={() => revoke(s.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
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
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">New password</span>
          <Input
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
              const { error } = await authClient.changePassword({
                currentPassword: current,
                newPassword: next,
                revokeOtherSessions: true,
              });
              if (error) {
                setMsg({ kind: "error", text: error.message ?? "Could not change password." });
              } else {
                setMsg({ kind: "ok", text: "Password updated." });
                setCurrent("");
                setNext("");
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
        setError(error.message ?? "Couldn't start setup.");
        return;
      }
      const uri = (data as { totpURI?: string })?.totpURI;
      setQr(uri ? await QRCode.toDataURL(uri, { margin: 1, width: 200 }) : null);
      setSecret(uri ? secretFromUri(uri) : null);
      setBackupCodes((data as { backupCodes?: string[] })?.backupCodes ?? []);
      setPhase("setup");
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
        setError(error.message ?? "Invalid code.");
        return;
      }
      setOn(true);
      setPhase("idle");
      reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setError(null);
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) {
        setError(error.message ?? "Couldn't disable.");
        return;
      }
      setOn(false);
      reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      icon={ShieldCheck}
      title="Two-factor authentication"
      description="Ask for a code from your authenticator app each time you sign in."
    >
      {on ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-emerald-300">✓ Two-factor authentication is on.</p>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Current password to disable"
            autoComplete="current-password"
          />
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
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Current password"
            autoComplete="current-password"
          />
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
            <p className="mb-1.5 text-sm text-muted">
              3. Enter the 6-digit code from your app to finish.
            </p>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              inputMode="numeric"
              maxLength={6}
              className="w-40 tracking-widest"
            />
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
        {error && (
          <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
            {error}
          </p>
        )}
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
                setError(error.message ?? "Couldn't delete the account.");
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
