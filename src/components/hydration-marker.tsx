"use client";

import { useEffect } from "react";

/**
 * Sets `<html data-hydrated="true">` once React has hydrated the page. The
 * end-to-end suite waits for it before a page's first click, fill or key
 * press, which could otherwise land before React's handlers and be lost.
 * Nothing in the app reads it.
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return null;
}
