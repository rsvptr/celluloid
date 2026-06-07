import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // App pages sit behind auth; share links and API routes shouldn't be crawled.
      disallow: ["/s/", "/api/"],
    },
  };
}
