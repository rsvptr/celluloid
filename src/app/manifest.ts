import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Celluloid",
    short_name: "Celluloid",
    description:
      "Your personal film & TV library. Track what you've watched and export it for anything.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0e14",
    theme_color: "#0a0e14",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/logo.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // No padded maskable asset exists yet — reusing the full-bleed "any"
      // icon with purpose:"maskable" gets clipped by Android's safe-zone
      // mask on install, so we omit a maskable entry until one is designed.
    ],
  };
}
