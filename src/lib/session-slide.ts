/** Where a browser keeps when it last asked for a session slide (ms since the epoch). */
export const SESSION_SLIDE_KEY = "celluloid:session-slide-at";

/** One slide request per browser per day, the session's updateAge in src/lib/auth.ts. */
export const SESSION_SLIDE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Claims today's session slide for this browser: true at most once per
 * SESSION_SLIDE_INTERVAL_MS, and the claim is stored before the caller makes
 * its request, so a failed request waits for the next day too. An unreadable
 * or future timestamp (the clock went back) counts as due. Without usable
 * storage (blocked, private mode, full) there is no way to keep to once a day,
 * so it never claims; the next server action or route handler slides the
 * session instead.
 */
export function claimSessionSlide(
  storage: () => Pick<Storage, "getItem" | "setItem">,
  now: number,
): boolean {
  try {
    const store = storage();
    const last = Number(store.getItem(SESSION_SLIDE_KEY) ?? Number.NaN);
    if (Number.isFinite(last) && last <= now && now - last < SESSION_SLIDE_INTERVAL_MS) {
      return false;
    }
    store.setItem(SESSION_SLIDE_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
