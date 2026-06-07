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
  sm: "h-8 px-3 text-sm min-h-10 sm:min-h-0",
  md: "h-10 px-4 text-sm",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

// --- Inputs ----------------------------------------------------------------

const fieldBase =
  "rounded-lg bg-surface-2 px-3 text-sm text-foreground placeholder:text-faint ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand/60 transition";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldBase, "h-10 w-full", className)} {...props} />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldBase, "py-2 min-h-20 w-full", className)} {...props} />
));
Textarea.displayName = "Textarea";

// Select sizes to its content by default (pass `w-full` where a full-width
// control is wanted, e.g. inside a form column).
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      fieldBase,
      "has-chevron h-9 pr-8 cursor-pointer appearance-none min-h-10 sm:min-h-0",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";

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

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] bg-surface ring-1 ring-line",
        className,
      )}
    >
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
