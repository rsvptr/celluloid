import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/**
 * Deduped per-request session lookup for server actions and route handlers.
 * Those can set cookies, so this is where Better Auth slides the session: once
 * `updateAge` has passed it extends the DB row and re-issues the cookie.
 */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

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
export async function requireUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user) throw new Error("You're signed out. Sign in and try again.");
  return session.user.id;
}
