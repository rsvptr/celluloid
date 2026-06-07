"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, Card, Input } from "@/components/ui";
import { AnimatePresence, motion } from "@/components/motion";

type Mode = "signin" | "signup" | "twofa";

export function AuthForm({ signupsDisabled }: { signupsDisabled: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignup = mode === "signup";
  const isTwoFa = mode === "twofa";

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
          setError(error.message ?? "Invalid code.");
          return;
        }
        done();
        return;
      }

      if (isSignup) {
        const { error } = await authClient.signUp.email({
          name: name.trim() || email.split("@")[0],
          email: email.trim(),
          password,
        });
        if (error) {
          setError(error.message ?? "Could not create account.");
          return;
        }
        done();
        return;
      }

      const { data, error } = await authClient.signIn.email({ email, password });
      if (error) {
        setError(error.message ?? "Sign-in failed.");
        return;
      }
      if ((data as { twoFactorRedirect?: boolean })?.twoFactorRedirect) {
        setMode("twofa");
        return;
      }
      done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (isTwoFa) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      >
      <Card className="p-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold">Two-factor authentication</h2>
            <p className="mt-0.5 text-xs text-muted">
              {useBackup
                ? "Enter one of your backup codes."
                : "Enter the 6-digit code from your authenticator app."}
            </p>
          </div>
          <Input
            value={code}
            onChange={(e) =>
              setCode(useBackup ? e.target.value : e.target.value.replace(/\D/g, ""))
            }
            placeholder={useBackup ? "backup code" : "123456"}
            inputMode={useBackup ? "text" : "numeric"}
            maxLength={useBackup ? 11 : 6}
            autoFocus
            className="tracking-widest"
          />
          {error && (
            <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={loading || !code}>
            {loading ? "Verifying…" : "Verify"}
          </Button>
          <button
            type="button"
            onClick={() => {
              setUseBackup((v) => !v);
              setCode("");
              setError(null);
            }}
            className="focus-ring rounded text-center text-sm text-muted hover:text-foreground"
          >
            {useBackup ? "Use an authenticator code" : "Use a backup code"}
          </button>
        </form>
      </Card>
      </motion.div>
    );
  }

  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AnimatePresence initial={false}>
          {isSignup && (
            <motion.div
              key="name"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSignup ? "At least 10 characters" : "••••••••"}
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
          />
        </Field>

        {error && (
          <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={loading} className="mt-1">
          {loading ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
        </Button>
      </form>

      {!signupsDisabled && (
        <p className="mt-5 text-center text-sm text-muted">
          {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(isSignup ? "signin" : "signup");
              setError(null);
            }}
            className="focus-ring rounded font-medium text-brand hover:underline"
          >
            {isSignup ? "Sign in" : "Create one"}
          </button>
        </p>
      )}
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
