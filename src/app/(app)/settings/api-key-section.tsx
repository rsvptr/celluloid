"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { Button, Input, softDisabledClass } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { removeAnthropicKey, setAnthropicKey } from "@/lib/settings-actions";
import { Notice, Section } from "./settings-ui";

export function ApiKeySection({
  hasApiKey,
  hasServerKey,
}: {
  hasApiKey: boolean;
  hasServerKey: boolean;
}) {
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(hasApiKey);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { confirm, dialog } = useConfirm();

  async function removeKey() {
    if (
      !(await confirm({
        title: "Remove your API key?",
        body: hasServerKey
          ? "Recommendations will use the app's shared key, and any daily limit its owner set, until you add a key again."
          : "AI recommendations will stop working until you add a key again.",
        confirmLabel: "Remove key",
        destructive: true,
      }))
    )
      return;
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
        // The Remove button that had focus is gone; adding a key is what's next.
        document.getElementById("settings-anthropic-api-key")?.focus();
      } catch {
        setError("Celluloid couldn't remove the API key. Check your connection and retry.");
      }
    });
  }

  return (
    <>
      {dialog}
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
          if (pending || !key.trim()) return;
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
            id="settings-anthropic-api-key"
            name="anthropic-api-key"
            type="password"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setStatus(null);
            }}
            placeholder="sk-ant-…"
            // Masked like a password, but it isn't a login: keep password
            // managers from offering to fill or save it.
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
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
              className={cn("text-rose-300 hover:text-rose-200", softDisabledClass)}
              aria-disabled={pending}
              onClick={() => {
                if (pending) return;
                void removeKey();
              }}
            >
              Remove
            </Button>
          )}
        </div>
      </form>
      </Section>
    </>
  );
}
