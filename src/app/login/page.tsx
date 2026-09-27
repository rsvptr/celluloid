import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/brand";
import { MotionProvider } from "@/components/motion";
import { signupsDisabled } from "@/lib/auth";
import { getOptionalUser } from "@/lib/session";
import { AuthForm } from "./auth-form";

export const metadata: Metadata = { title: "Sign in" };

const FILM_HOLES = Array.from({ length: 7 }, (_, index) => index);

function FilmPerforations() {
  return (
    <div className="flex flex-col justify-between py-1">
      {FILM_HOLES.map((hole) => (
        <span
          key={hole}
          className="h-7 w-4 rounded-[0.3rem] border border-white/10 bg-background/80 shadow-inner shadow-black/60"
        />
      ))}
    </div>
  );
}

export default async function LoginPage() {
  const user = await getOptionalUser();
  if (user) redirect("/");

  return (
    // Desktop frame is locked to the viewport (lg:h-dvh + overflow-hidden):
    // the page itself never scrolls; the form column scrolls internally on
    // short screens instead. Ambience (glow, grid texture, top accent line)
    // lives on MAIN so both columns share one continuous canvas - no seam.
    // MotionProvider is mounted here (not the root layout) because this page
    // and the authed shell are the only Motion users; the provider is what
    // makes the form's transitions honor the OS reduce-motion setting. The
    // column's entrance is CSS, so the form is visible before any JS runs.
    <MotionProvider>
    <main className="relative min-h-dvh overflow-hidden lg:grid lg:h-dvh lg:grid-cols-[minmax(0,1.08fr)_minmax(28rem,0.92fr)]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {/* Radial glows are desktop-only (mobile has its own hero-float glow);
            the grid texture and brand accent line carry the identity on every
            breakpoint. */}
        <div className="absolute inset-0 hidden bg-[radial-gradient(circle_at_22%_38%,rgba(45,212,238,0.12),transparent_30%),radial-gradient(circle_at_58%_78%,rgba(37,99,235,0.10),transparent_32%),radial-gradient(circle_at_88%_18%,rgba(45,212,238,0.07),transparent_26%)] lg:block" />
        <div className="absolute inset-0 opacity-[0.03] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:64px_64px]" />
        <div className="absolute inset-x-0 top-0 h-px brand-gradient opacity-80" />
      </div>

      <div
        aria-hidden="true"
        className="relative hidden overflow-hidden lg:flex lg:h-full lg:flex-col"
      >

        <div className="relative z-10 flex items-center px-10 py-8 xl:px-14 xl:py-10">
          <Wordmark size={34} href={null} textClassName="text-xl" />
        </div>

        <div className="relative z-10 flex flex-1 items-center justify-center px-10 py-6">
          {/* min() sizing: the filmstrip shrinks with viewport height so the
              locked h-dvh frame never clips it on short laptop screens. */}
          <div className="relative h-[min(31rem,56dvh)] w-[min(24rem,43dvh)] max-w-full">
            <div className="absolute left-1/2 top-1/2 h-[27rem] w-[19rem] -translate-x-[43%] -translate-y-[52%] rotate-[8deg] rounded-[2rem] border border-brand-blue/15 bg-brand-blue/[0.025]" />
            <div className="absolute inset-0 rotate-[-5deg] rounded-[2rem] border border-white/10 bg-[#0d1420]/85 p-5 shadow-[0_34px_100px_-42px_rgba(14,165,233,0.58)] ring-1 ring-black/40 backdrop-blur-sm">
              <div className="grid h-full grid-cols-[1rem_minmax(0,1fr)_1rem] gap-4">
                <FilmPerforations />
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="relative flex-[1.05] overflow-hidden rounded-xl border border-white/10 bg-[radial-gradient(circle_at_28%_32%,rgba(45,212,238,0.24),transparent_25%),linear-gradient(145deg,rgba(24,32,46,0.96),rgba(10,14,20,0.96))]">
                    <span className="absolute bottom-5 left-5 h-px w-20 bg-brand-cyan/55" />
                    <span className="absolute bottom-8 left-5 h-px w-11 bg-white/15" />
                  </div>
                  <div className="relative flex-1 overflow-hidden rounded-xl border border-white/10 bg-[linear-gradient(135deg,rgba(59,130,246,0.14),transparent_48%),linear-gradient(160deg,rgba(24,32,46,0.9),rgba(10,14,20,0.98))]">
                    <span className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand-sky/25" />
                    <span className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand-cyan/20" />
                  </div>
                  <div className="relative flex-[0.85] overflow-hidden rounded-xl border border-white/10 bg-[radial-gradient(circle_at_72%_64%,rgba(37,99,235,0.2),transparent_30%),linear-gradient(145deg,rgba(16,25,38,0.94),rgba(10,14,20,0.98))]">
                    <span className="absolute right-5 top-5 h-px w-16 bg-brand-blue/55" />
                    <span className="absolute right-5 top-8 h-px w-9 bg-white/15" />
                  </div>
                </div>
                <FilmPerforations />
              </div>
            </div>
          </div>
        </div>

        <div className="relative z-10 px-10 pb-10 xl:px-14 xl:pb-12">
          <p className="max-w-md text-2xl font-semibold tracking-[-0.035em] text-foreground xl:text-3xl">
            Your personal film &amp; TV library.
          </p>
        </div>
      </div>

      <section className="relative flex min-h-dvh items-center justify-center px-4 py-12 sm:px-8 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:px-12">
        <div
          aria-hidden="true"
          className="hero-float pointer-events-none absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-brand/20 blur-[120px] lg:hidden"
        />
        <div className="relative w-full max-w-sm motion-safe:animate-[enter-rise_250ms_var(--ease-out)]">
          <div className="mb-8 flex flex-col items-center text-center lg:hidden">
            <Wordmark size={56} href={null} className="flex-col gap-3" />
            <p className="mt-4 text-sm text-muted">
              Your personal film &amp; TV library.
            </p>
          </div>
          <Suspense fallback={null}>
            <AuthForm signupsDisabled={signupsDisabled} />
          </Suspense>
        </div>
      </section>
    </main>
    </MotionProvider>
  );
}
