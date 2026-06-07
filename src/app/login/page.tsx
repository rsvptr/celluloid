import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getOptionalUser } from "@/lib/session";
import { signupsDisabled } from "@/lib/auth";
import { Wordmark } from "@/components/brand";
import { FadeIn, MotionProvider } from "@/components/motion";
import { AuthForm } from "./auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const user = await getOptionalUser();
  if (user) redirect("/");

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-12">
      {/* Ambient brand glow */}
      <div
        aria-hidden
        className="hero-float pointer-events-none absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-brand/20 blur-[120px]"
      />
      <MotionProvider>
        <FadeIn className="relative w-full max-w-sm" y={14}>
          <div className="mb-8 flex flex-col items-center text-center">
            <Wordmark size={56} href={null} className="flex-col gap-3" />
            <p className="mt-4 text-sm text-muted">
              Your personal film &amp; TV library.
            </p>
          </div>
          <Suspense fallback={null}>
            <AuthForm signupsDisabled={signupsDisabled} />
          </Suspense>
        </FadeIn>
      </MotionProvider>
    </main>
  );
}
