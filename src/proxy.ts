import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Routes that don't require a session. /s/ is the public share viewer; it must
// stay reachable with no account or the whole share feature breaks.
const PUBLIC_PATHS = ["/login", "/s"];

const matches = (paths: string[], pathname: string) =>
  paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/**
 * Next.js 16 proxy (formerly middleware). This is a COARSE, edge-safe gate that
 * only checks for the presence of the session cookie — the authoritative check
 * is `auth.api.getSession(...)` inside server components / route handlers.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = getSessionCookie(request) != null;

  if (!hasSession && !matches(PUBLIC_PATHS, pathname)) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Deliberately NO `hasSession && /login -> /` redirect here. getSessionCookie()
  // only proves the cookie EXISTS, not that it is valid. On a stale or forged
  // cookie such a redirect would bounce /login -> /, then the (app) layout's
  // authoritative requireUser() check would reject the dead session and bounce
  // / -> /login; since neither side clears the cookie, the two would ping-pong
  // forever and lock the owner out until they manually cleared cookies. The real
  // /login -> / redirect for genuinely signed-in users lives in
  // src/app/login/page.tsx, which calls getOptionalUser() (a true session check)
  // and therefore never fires on an invalid cookie.

  // -- Content-Security-Policy (nonce-based) ----------------------------------
  // Only the pass-through response below carries the CSP; the redirects above
  // don't render HTML, so they don't need it. This follows the OFFICIAL Next.js
  // nonce recipe (https://nextjs.org/docs/app/guides/content-security-policy):
  // put a fresh per-request nonce on the *request* headers so Next stamps it
  // onto its own framework <script> tags, and also send the CSP on the response
  // so the browser enforces it. The static CSP that used to live in
  // next.config.ts has been removed to avoid a conflicting duplicate header.
  //
  // !! SMOKE-TEST ON A VERCEL *PREVIEW* DEPLOY BEFORE PRODUCTION. A wrong
  //    script-src blocks ALL app JavaScript -> blank page, no hydration. On the
  //    preview: load a page, open the DevTools console, and confirm there are
  //    NO "Refused to execute/load ... Content Security Policy" errors before
  //    promoting. Exercise client-side navigation too: if a prefetched/cached
  //    route ever shows a nonce mismatch, the documented remedy is to skip
  //    prefetch requests in `config.matcher` (the `missing` headers form) --
  //    apply that only after testing, since it changes which requests the auth
  //    gate above runs on.
  //
  // Edge runtime: use Web Crypto (crypto.getRandomValues) + btoa. Do NOT import
  // node:crypto or use Buffer -- neither exists on the edge.
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  // React's dev build uses eval() for debugging (callstack reconstruction,
  // Fast Refresh); production never does. Allow 'unsafe-eval' ONLY in dev so
  // the production policy stays strict.
  const devEval = process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : "";

  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' trusts scripts pulled in by the nonce'd bootstrap and
    // ignores the host allowlist; 'self' stays as a fallback for older browsers.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    // 'unsafe-inline' is for STYLES ONLY -- Tailwind and Next inject inline
    // styles that carry no nonce. Never widen script-src like this.
    "style-src 'self' 'unsafe-inline'",
    // Posters load from TMDB; QR codes and other canvases render as data: URLs;
    // blob: covers object URLs (e.g. the export download).
    "img-src 'self' https://image.tmdb.org data: blob:",
    // All client fetches hit same-origin /api/* route handlers.
    "connect-src 'self'",
    // next/font self-hosts under /_next, so 'self' is enough.
    "font-src 'self'",
    // Carried over verbatim from the old static CSP in next.config.ts.
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  // Set the nonce + CSP on the request headers so Next can read the nonce while
  // rendering, then mirror the CSP onto the response for browser enforcement.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

// The proxy file must live in src/ (beside app/) or Next never registers it;
// the matcher is read from `export const config` (verified against the
// installed next@16.2.10 source — it extracts `config`, not `proxyConfig`).
// Without this matcher the proxy runs on every asset and API route, attaching
// a unique-nonce CSP that breaks static caching and redirecting JSON API
// calls to the /login HTML page.
export const config = {
  // Exclude the auth API, Next internals, static assets and PWA files.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon-192.png|logo.png|tmdb-logo.svg|robots.txt|sitemap.xml).*)",
  ],
};
