import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/** Deduped per-request session lookup. */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

/** Returns the signed-in user or redirects to /login. Use in protected pages. */
export async function requireUser() {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  return session.user;
}

/** Returns the signed-in user or null (no redirect). */
export async function getOptionalUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/** Returns the signed-in user's id or throws (for server actions / route handlers). */
export async function requireUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user) throw new Error("Unauthorized");
  return session.user.id;
}
