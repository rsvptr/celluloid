import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

const getCachedSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

const getDatabaseSession = cache(async () => {
  return auth.api.getSession({ headers: await headers(), query: { disableCookieCache: true } });
});

/**
 * Options for high-impact work. `skipCookieCache` reads the session row instead
 * of the 60-second session_data cookie cache, so a session revoked on another
 * device is refused at once rather than within a minute. It costs a database
 * read, so use it only where that minute matters: backup export and restore,
 * and API key changes.
 */
export interface SessionOptions {
  skipCookieCache?: boolean;
}

/**
 * Deduped per-request session lookup for server actions and route handlers.
 * Those can set cookies, so this is where Better Auth slides the session: once
 * `updateAge` has passed it extends the DB row and re-issues the cookie.
 */
export async function getSession(options?: SessionOptions) {
  return options?.skipCookieCache ? getDatabaseSession() : getCachedSession();
}

/**
 * Deduped lookup for pages and layouts, which can't set cookies. A refresh here
 * would extend the DB row and then silently drop the new cookie, and the
 * extended row would stop the next action from refreshing, so the cookie never
 * slid. Reading without refreshing leaves the slide to the next action or
 * route handler, which writes the row and the cookie together.
 */
const getRenderSession = cache(async () => {
  return auth.api.getSession({ headers: await headers(), query: { disableRefresh: true } });
});

/** Returns the signed-in user or redirects to /login. Use in protected pages. */
export async function requireUser() {
  const session = await getRenderSession();
  if (!session?.user) redirect("/login");
  return session.user;
}

/** Returns the signed-in user or null (no redirect). Use in pages. */
export async function getOptionalUser() {
  const session = await getRenderSession();
  return session?.user ?? null;
}

/** Returns the signed-in user's id or throws (for server actions / route handlers). */
export async function requireUserId(options?: SessionOptions): Promise<string> {
  const session = await getSession(options);
  if (!session?.user) throw new Error("You're signed out. Sign in and try again.");
  return session.user.id;
}
