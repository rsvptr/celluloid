import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // Same-origin by default; set NEXT_PUBLIC_SITE_URL if the API lives elsewhere.
  baseURL: process.env.NEXT_PUBLIC_SITE_URL,
  plugins: [twoFactorClient()],
});

export const { signIn, signOut, useSession } = authClient;
