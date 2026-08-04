import * as React from "react";
import { cn } from "@/lib/utils";

// --- Button ----------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "text-[#04121c] font-semibold brand-gradient hover:opacity-90 shadow-sm shadow-brand/20",
  secondary:
    "bg-surface-2 text-foreground ring-1 ring-line hover:bg-surface-2/70",
  ghost: "text-muted hover:text-foreground hover:bg-surface-2/60",
  danger:
    "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30 hover:bg-rose-500/25",
};

const buttonSizes: Record<ButtonSize, string> = {
  // Taller hit area on touch (mobile); compact on desktop via sm:min-h-0.
  sm: "h-8 px-3 text-sm min-h-11 sm:min-h-0",
  // min-h (not h-) so content can never overflow the box; sm:min-h-10
  // reproduces the old fixed h-10 exactly once content fits within it.
  md: "min-h-11 sm:min-h-10 px-4 text-sm",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

// React 19: `ref` is a regular prop — no forwardRef wrapper needed.
export function Button({
  className,
  variant = "secondary",
  size = "md",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)}
      {...props}
    />
  );
}

// --- Inputs ----------------------------------------------------------------

const fieldBase =
  "rounded-lg bg-surface-2 px-3 text-base sm:text-sm text-foreground placeholder:text-faint ring-1 ring-line-strong focus:outline-none focus:ring-2 focus:ring-brand/60 transition";

// ComponentProps<"input"> (not InputHTMLAttributes<HTMLInputElement>): the
// latter is attributes-only and has no `ref` field, so callers couldn't get a
// ref to the underlying <input> through this wrapper. React 19 treats `ref` as
// a plain prop for function components — no forwardRef needed — but the type
// still has to include it, which ComponentProps<"input"> does.
export function Input({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return <input className={cn(fieldBase, "h-11 sm:h-10 w-full", className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={cn(fieldBase, "py-2 min-h-20 w-full", className)} {...props} />
  );
}

// Select sizes to its content by default (pass `w-full` where a full-width
// control is wanted, e.g. inside a form column).
export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        fieldBase,
        "has-chevron h-9 pr-8 cursor-pointer appearance-none min-h-11 sm:min-h-0",
        className,
      )}
      {...props}
    />
  );
}

// --- Badge -----------------------------------------------------------------

export function Badge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        className,
      )}
    >
      {children}
    </span>
  );
}

// --- Card ------------------------------------------------------------------

type CardVariant = "panel" | "inset" | "plain" | "danger";

const cardVariants: Record<CardVariant, string> = {
  /** Default surface: elevated bg + hairline ring. Top-level content blocks. */
  panel: "rounded-[var(--radius-card)] bg-surface ring-1 ring-line",
  /** Recessed, ringless surface for a control group nested inside a panel. */
  inset: "rounded-lg bg-surface-2",
  /** No fill or ring — a section whose grouping reads from spacing alone. */
  plain: "",
  /** Low-saturation destructive enclosure for irreversible actions (matches
   *  the settings danger-zone treatment). No call sites yet. */
  danger: "rounded-lg bg-rose-500/5 ring-1 ring-rose-500/25",
};

export function Card({
  className,
  variant = "panel",
  children,
}: {
  className?: string;
  variant?: CardVariant;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(cardVariants[variant], className)}>
      {children}
    </div>
  );
}

// --- Spinner ---------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin", className)}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
