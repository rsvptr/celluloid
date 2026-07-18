import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    // Ignored over plain HTTP; takes effect on the HTTPS production deploy.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    // The app uses none of these browser capabilities; saying so explicitly
    // also covers anything embedded in future.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // NOTE: Content-Security-Policy is intentionally NOT set here. It is now a
  // per-request, nonce-based header generated in proxy.ts (the official Next.js
  // nonce pattern needs a fresh nonce per request, which a static config header
  // cannot provide). Setting it here as well would emit a conflicting duplicate
  // CSP header. See proxy.ts for the full policy (script-src nonce +
  // strict-dynamic, plus frame-ancestors/object-src/base-uri/form-action).
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
    ],
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // proxy.ts's nonce-based CSP only runs on the document-request matcher
      // (which excludes /api/*), so API responses got none of the four
      // document-scoped directives below — restore them here for that path.
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
