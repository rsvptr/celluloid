"use client";

import { useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { KeyRound } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Notice, Section } from "./settings-ui";

export function PasswordSection() {
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
