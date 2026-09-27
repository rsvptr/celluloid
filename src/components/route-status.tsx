"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

const ROUTE_STATUS_ID = "route-status";

function subscribeNoop() {
  return () => {};
}

/**
 * The app shell's persistent polite live region (JK-23). Screen readers
 * reliably announce text added to a region that already exists, not a region
 * inserted along with its text, so it lives in the layout, outside <main> and
 * any skeleton's aria-busy root.
 */
export function RouteStatus() {
  return <div id={ROUTE_STATUS_ID} role="status" className="sr-only" />;
}

/**
 * Screen-reader text for a loading skeleton, which is otherwise silent.
 * Portals into RouteStatus on mount, so the text is announced; it leaves on
 * unmount, and removals aren't announced.
 */
export function LoadingStatus({ children }: { children: React.ReactNode }) {
  // Null on the server and during hydration, the region after.
  const region = useSyncExternalStore(
    subscribeNoop,
    () => document.getElementById(ROUTE_STATUS_ID),
    () => null,
  );
  return region ? createPortal(children, region) : null;
}
