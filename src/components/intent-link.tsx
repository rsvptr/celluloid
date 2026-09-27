"use client";

import type { ComponentProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * A Link that prefetches on intent (hover, focus, touch) instead of on
 * viewport entry. Without Partial Prefetching every visible dynamic Link sends
 * its own server request, so a scrolled grid fires one per card (VE-06).
 * `prefetch={false}` alone would also switch off Next's hover prefetch.
 */
export function IntentLink(
  props: Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string },
) {
  const router = useRouter();
  const warm = () => router.prefetch(props.href);
  return (
    <Link {...props} prefetch={false} onMouseEnter={warm} onFocus={warm} onTouchStart={warm} />
  );
}
