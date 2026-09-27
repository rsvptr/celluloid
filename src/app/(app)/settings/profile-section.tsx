"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { User } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { updateProfile } from "@/lib/settings-actions";
import { Notice, Section } from "./settings-ui";

export function ProfileSection({ name, email }: { name: string; email: string }) {
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
          if (pending || value.trim() === name) return;
          start(async () => {
            try {
              const r = await updateProfile(value);
              if (r.error) {
                setMsg({ kind: "error", text: r.error });
              } else {
                setMsg({ kind: "ok", text: "Profile saved." });
                // Unlike the other sections, the action's own re-render isn't
                // enough here. The header's name comes from Better Auth's
                // session_data cookie cache, and that render still reads the
                // request's old Cookie header (Next syncs cookies(), not
                // headers()), so it serves the old name. This request sends the
                // cookie updateUser just set.
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
