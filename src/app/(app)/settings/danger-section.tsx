"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, Input, softDisabledClass } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { Notice, Section } from "./settings-ui";

export function DangerSection() {
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
            try {
              // The auth boundary requires and verifies this password even for
              // a fresh session, so a session cookie alone cannot delete data.
              const { error } = await authClient.deleteUser({ password });
              if (error) {
                setError(error.message ?? "Couldn't delete the account. Try again.");
                return;
              }
            } catch {
              setError("Celluloid couldn't delete your account. Check your connection and retry.");
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
