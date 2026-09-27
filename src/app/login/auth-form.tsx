"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "@/components/motion";
import { Button, Card, Input } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

type Mode = "signin" | "signup" | "twofa";

const SAFE_PATH_ORIGIN = "https://celluloid.invalid";

/**
 * Normalizes a post-authentication destination to an origin-free internal path.
 * Backslashes and control characters are rejected before and after decoding so
 * browser URL normalization cannot turn an apparently local path into a host.
 */
export function safeInternalPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";

  let decoded = raw;
  for (let pass = 0; pass < 3; pass += 1) {
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) {
      return "/";
    }
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return "/";
    }
  }

  if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) {
    return "/";
  }

  try {
    const url = new URL(raw, SAFE_PATH_ORIGIN);
    if (url.origin !== SAFE_PATH_ORIGIN) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function friendlyAuthError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (
    error instanceof TypeError ||
    /failed to fetch|network|load failed/i.test(message)
  ) {
    return "Celluloid couldn't reach the sign-in service. Check your connection and try again.";
  }
  return message || fallback;
}

export function AuthForm({ signupsDisabled }: { signupsDisabled: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeInternalPath(params.get("next"));

  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignup = mode === "signup";
  const isTwoFa = mode === "twofa";

  // Avoid opening the software keyboard as soon as the 2FA screen appears on
  // mobile. Desktop users still land directly in the one-time-code field.
  useEffect(() => {
    if (!isTwoFa || !window.matchMedia("(min-width: 768px)").matches) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById("login-two-factor-code")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isTwoFa, useBackup]);

  function done() {
    router.push(next);
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (isTwoFa) {
        const { error } = useBackup
          ? await authClient.twoFactor.verifyBackupCode({ code })
          : await authClient.twoFactor.verifyTotp({ code });
        if (error) {
          setError(
            friendlyAuthError(
              new Error(error.message ?? ""),
              "That code wasn't accepted. Check it and try again.",
            ),
          );
          return;
        }
        done();
        return;
      }

      if (isSignup) {
        const signup = {
          name: name.trim() || email.split("@")[0],
          email: email.trim(),
          password,
          inviteCode: inviteCode.trim(),
        };
        const { error } = await authClient.signUp.email(signup);
        if (error) {
          setError(
            friendlyAuthError(
              new Error(error.message ?? ""),
              "Could not create the account. Check the details and try again.",
            ),
          );
          return;
        }
        done();
        return;
      }

      const { data, error } = await authClient.signIn.email({ email, password });
      if (error) {
        setError(
          friendlyAuthError(
            new Error(error.message ?? ""),
            "Sign-in failed. Check your email and password, then try again.",
          ),
        );
        return;
      }
      if ((data as { twoFactorRedirect?: boolean })?.twoFactorRedirect) {
        setMode("twofa");
        return;
      }
      done();
    } catch (err) {
      setError(friendlyAuthError(err, "Sign-in failed. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  if (isTwoFa) {
    return (
      // CSS entrance, so the code form can't be left invisible by a failed
      // Motion feature chunk.
      <div className="motion-safe:animate-[enter-scale_250ms_cubic-bezier(0.16,1,0.3,1)]">
        <Card className="p-6 lg:p-7">
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <h1 className="text-sm font-semibold lg:text-xl lg:tracking-tight">
                Two-factor authentication
              </h1>
              <p className="mt-1 text-xs text-muted lg:text-sm">
                {useBackup
                  ? "Enter one of your backup codes."
                  : "Enter the 6-digit code from your authenticator app."}
              </p>
            </div>
            <Field
              label={useBackup ? "Backup code" : "Authenticator code"}
              htmlFor="login-two-factor-code"
            >
              <Input
                id="login-two-factor-code"
                name={useBackup ? "backup-code" : "one-time-code"}
                value={code}
                onChange={(e) =>
                  setCode(
                    useBackup ? e.target.value : e.target.value.replace(/\D/g, ""),
                  )
                }
                placeholder={useBackup ? "ABCD-EFGH" : "123456"}
                inputMode={useBackup ? "text" : "numeric"}
                maxLength={useBackup ? 11 : 6}
                autoComplete="one-time-code"
                spellCheck={false}
                className="h-11 tracking-widest sm:h-11"
              />
            </Field>
            {error ? <AuthError message={error} /> : null}
            <Button type="submit" variant="primary" disabled={loading || !code}>
              {loading ? "Verifying…" : "Verify"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setUseBackup((value) => !value);
                setCode("");
                setError(null);
              }}
              className="focus-ring min-h-11 rounded text-center text-sm text-muted hover:text-foreground sm:min-h-0"
            >
              {useBackup ? "Use an authenticator code" : "Use a backup code"}
            </button>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <Card className="p-6 lg:p-7">
      <div className="mb-6 hidden lg:block">
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">
          {isSignup ? "Create your account" : "Sign in to Celluloid"}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {isSignup
            ? "Set up your private library."
            : "Open your personal library."}
        </p>
      </div>
      <h1 className="sr-only lg:hidden">
        {isSignup ? "Create your Celluloid account" : "Sign in to Celluloid"}
      </h1>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AnimatePresence initial={false}>
          {isSignup ? (
            <motion.div
              key="name"
              // The reveal is CSS (collapse-in), so the fields are visible even
              // if Motion's features never load; Motion only runs the exit (and
              // a reopen mid-exit). Without features it unmounts at once, so
              // the closed fields are never focusable.
              initial={false}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              // -m-1 + inner p-1: the height animation needs overflow-hidden,
              // but that clips the Input's focus ring (a box-shadow). The inner
              // padding gives the ring room inside the clip box; the negative
              // margin cancels it in the layout, keeping field rhythm identical.
              // -mb-3 here and pb-3 inside also cancel the form's gap-4 below
              // this first child, so the collapsed region takes no space and
              // the Email field never jumps.
              className="-m-1 -mb-3 grid grid-rows-[1fr] overflow-hidden motion-safe:animate-[collapse-in_220ms_cubic-bezier(0.16,1,0.3,1)]"
            >
              <div className="min-h-0">
              <div className="flex flex-col gap-4 p-1 pb-3">
                <Field label="Name" htmlFor="login-name">
                  <Input
                    id="login-name"
                    name="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    autoComplete="name"
                    className="h-11 sm:h-11"
                  />
                </Field>
                <Field label="Invite code" htmlFor="login-invite-code">
                  <Input
                    id="login-invite-code"
                    name="invite-code"
                    type="password"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    autoComplete="off"
                    aria-describedby="login-invite-help"
                    className="h-11 sm:h-11"
                    required
                  />
                  <p id="login-invite-help" className="text-xs text-faint">
                    Use the code you received with your invitation.
                  </p>
                </Field>
              </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <Field label="Email" htmlFor="login-email">
          <Input
            id="login-email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            spellCheck={false}
            className="h-11 sm:h-11"
            required
          />
        </Field>

        <Field label="Password" htmlFor="login-password">
          <div className="relative">
            <Input
              id="login-password"
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
              onKeyUp={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
              onBlur={() => setCapsLockOn(false)}
              placeholder={isSignup ? "At least 10 characters" : "••••••••"}
              autoComplete={isSignup ? "new-password" : "current-password"}
              autoCapitalize="none"
              aria-describedby={capsLockOn ? "login-caps-lock" : undefined}
              className="h-11 pr-12 sm:h-11"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="focus-ring absolute inset-y-0 right-0 flex min-w-11 items-center justify-center rounded-r-lg text-faint transition-colors hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff aria-hidden="true" size={17} />
              ) : (
                <Eye aria-hidden="true" size={17} />
              )}
            </button>
          </div>
          {capsLockOn ? (
            <p id="login-caps-lock" role="status" className="text-xs text-warning">
              Caps Lock is on.
            </p>
          ) : null}
        </Field>

        {error ? <AuthError message={error} /> : null}

        <Button type="submit" variant="primary" disabled={loading} className="mt-1">
          {loading ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
        </Button>

        {isSignup ? (
          <p className="text-xs leading-relaxed text-faint">
            After you join, turn on two-factor authentication in Settings for extra
            protection.
          </p>
        ) : null}
      </form>

      {!signupsDisabled ? (
        <p className="mt-5 text-center text-sm text-muted">
          {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(isSignup ? "signin" : "signup");
              setError(null);
              setCapsLockOn(false);
            }}
            className="focus-ring min-h-11 rounded font-medium text-brand hover:underline sm:min-h-0"
          >
            {isSignup ? "Sign in" : "Create one"}
          </button>
        </p>
      ) : null}
    </Card>
  );
}

function AuthError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20"
    >
      {message}
    </p>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
