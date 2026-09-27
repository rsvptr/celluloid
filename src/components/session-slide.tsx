"use client";

import { useEffect } from "react";
import { claimSessionSlide } from "@/lib/session-slide";

/**
 * Slides the 30-day session while the app is in use. Pages read the session
 * without refreshing it, because a render can't set the new cookie (BA-03), so
 * on its own the session slid only on the day's first server action or API
 * call. Once a day per browser, and only while the tab is visible, this asks
 * Better Auth's get-session endpoint to read the session row rather than the
 * cookie cache. Past `updateAge` that request extends the row and re-sets the
 * cookie, since it runs in a route handler. It renders nothing, and a failure
 * is ignored.
 */
export function SessionSlide() {
  useEffect(() => {
    async function slide() {
      if (document.visibilityState !== "visible") return;
      if (!claimSessionSlide(() => window.localStorage, Date.now())) return;
      try {
        // Loaded on demand, as nav.tsx does for sign-out, so the auth client
        // stays out of the shell of every signed-in page (VE-11).
        const { authClient } = await import("@/lib/auth-client");
        await authClient.getSession({ query: { disableCookieCache: true } });
      } catch {
        // The next server action or route handler slides the session instead.
      }
    }
    const onVisibilityChange = () => void slide();
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  return null;
}
