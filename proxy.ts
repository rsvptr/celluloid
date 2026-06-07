import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Public routes that don't require a session.
const PUBLIC_PATHS = ["/login"];

/**
 * Next.js 16 proxy (formerly middleware). This is a COARSE, edge-safe gate that
 * only checks for the presence of the session cookie — the authoritative check
 * is `auth.api.getSession(...)` inside server components / route handlers.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = getSessionCookie(request) != null;
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!hasSession && !isPublic) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (hasSession && isPublic) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Exclude the auth API, Next internals, static assets and PWA files.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon-192.png|logo.png|robots.txt|sitemap.xml).*)",
  ],
};
