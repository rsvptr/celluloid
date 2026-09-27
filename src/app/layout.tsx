import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { env } from "@/lib/env";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Not preloaded: font-mono appears only in the share link, the export preview
// and the 2FA setup key and backup codes, so every other page would fetch it
// for nothing. It still loads (display: swap) where it's used (VE-10).
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: {
    default: "Celluloid",
    template: "%s · Celluloid",
  },
  description:
    "Your personal film & TV library. Track what you've watched, season by season, and export it for anything.",
  applicationName: "Celluloid",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/icon-192.png", sizes: "192x192" }],
  },
  appleWebApp: {
    capable: true,
    title: "Celluloid",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0e14",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Motion and the toaster are provided by the layouts that use them —
          the authenticated shell and the login page — not here. Mounting them
          at the root shipped the Motion and sonner chunks to the public share
          page and the not-found route, which render neither an animation nor
          a toast (AUD-NEXT-02). */}
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
