import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <Image
      src="/logo.png"
      alt="Celluloid"
      width={size}
      height={size}
      priority
      className="select-none"
    />
  );
}

export function Wordmark({
  size = 32,
  href = "/",
  className,
  textClassName,
}: {
  size?: number;
  href?: string | null;
  className?: string;
  textClassName?: string;
}) {
  const inner = (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark size={size} />
      <span
        className={cn(
          "text-lg font-semibold tracking-tight text-gradient",
          textClassName,
        )}
      >
        Celluloid
      </span>
    </span>
  );
  if (href === null) return inner;
  return (
    // shrink-0: in a packed flex header the brand is the first thing the
    // browser squeezes, and a logo collapsed to 0px just looks missing.
    <Link href={href} className="focus-ring inline-flex shrink-0 rounded">
      {inner}
    </Link>
  );
}
