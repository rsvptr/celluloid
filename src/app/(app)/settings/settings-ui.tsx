"use client";

import { toast } from "sonner";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

export function Section({
  icon: Icon,
  title,
  description,
  headingId,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description?: string;
  /**
   * Makes the heading a focus target with this id, for when an action in the
   * section removes the control that had focus (a deleted row).
   */
  headingId?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="h-full p-5">
      <div className="mb-4 flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 text-brand">
          <Icon size={20} />
        </span>
        <div>
          <h2
            id={headingId}
            tabIndex={headingId ? -1 : undefined}
            className={cn("text-sm font-semibold", headingId && "outline-none")}
          >
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
      </div>
      {children}
    </Card>
  );
}

export function Notice({
  kind,
  focusId,
  children,
}: {
  kind: "ok" | "error";
  /** Makes the notice a focus target with this id (see Section's headingId). */
  focusId?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      id={focusId}
      tabIndex={focusId ? -1 : undefined}
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
      className={cn(
        kind === "ok"
          ? "rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/20"
          : "rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20",
        focusId && "outline-none",
      )}
    >
      {children}
    </p>
  );
}

export async function copyText(text: string, okMsg = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMsg);
  } catch {
    toast.error("Couldn't copy that. Select it and copy manually.");
  }
}
