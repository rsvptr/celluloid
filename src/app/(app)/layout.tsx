import { Toaster } from "sonner";
import { requireUser } from "@/lib/session";
import { Nav } from "@/components/nav";
import { MotionProvider } from "@/components/motion";
import { LazyCommandPalette } from "@/components/command-palette-lazy";
import { RouteStatus } from "@/components/route-status";
import { SessionSlide } from "@/components/session-slide";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  // The command palette fetches its title index lazily on first open, so the
  // layout doesn't run (and serialize) a whole-library query on every page.
  return (
    <MotionProvider>
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-brand"
      >
        Skip to content
      </a>
      <Nav userName={user.name} />
      {/* Bottom padding clears the fixed mobile tab bar (~56px + safe-area
          inset) so the last row of content is never hidden behind it; lg+
          reverts to the original symmetric py-6 since that bar is hidden at lg
          (AUD-08 moved the nav's desktop/mobile switch from md to lg). */}
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-[calc(5rem+env(safe-area-inset-bottom))] outline-none lg:pb-6"
      >
        {children}
      </main>
      <RouteStatus />
      <LazyCommandPalette />
      <SessionSlide />
      <Toaster
        theme="dark"
        position="bottom-right"
        // 4.5rem clears the mobile tab bar, but not the library's bulk bar,
        // which is taller and sat under the toast for its whole four seconds.
        // The bulk bar publishes its measured height as --toast-bottom while it
        // is open and drops the property when it closes, so the fallback stays
        // the tab-bar offset the rest of the app needs.
        // Desktop reads the same property (EM-07): the right-aligned toast
        // otherwise covers the bar's Share, Remove and Done below ~1,800px
        // wide. 24px is Sonner's own desktop default, so other pages don't move.
        // Sonner's desktop layout starts at 601px, but the tab bar shows until
        // lg (nav.tsx, lg:hidden), so below lg the fallback clears it too.
        // The offsets stay at rest; toast-lift (globals.css) raises the toaster
        // by the difference on `translate`, so it eases back down with the bar
        // instead of snapping when the bar closes.
        className="toast-lift [--toast-desktop-bottom:calc(4.5rem+env(safe-area-inset-bottom))] lg:[--toast-desktop-bottom:24px]"
        offset={{ bottom: "var(--toast-desktop-bottom, 24px)" }}
        mobileOffset={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom))" }}
        toastOptions={{
          style: {
            background: "var(--color-surface)",
            border: "1px solid var(--color-line)",
            color: "var(--color-foreground)",
          },
          classNames: {
            // Undo parks focus on the toast (undo-toast.ts); Sonner's own
            // focus shadow is invisible on dark, so use the app's ring.
            toast: "focus-ring",
            actionButton: "min-h-11 sm:min-h-0",
            // Sonner's dark close button is an off-palette black disc (1.2:1
            // on surface). Tokens instead: border 3.4:1 on surface, glyph 14:1.
            // `!` beats Sonner's unlayered theme rules.
            closeButton:
              "focus-ring bg-surface-2! border-line-strong! text-foreground! hover:bg-line!",
            // The inline style above beat richColors (JK-20), so errors looked
            // like successes. They get the danger token on the border (its
            // `!` beats the inline style) and the icon (6.4:1 on surface);
            // the text stays foreground (15:1).
            error: "border-danger/60! [&_[data-icon]]:text-danger",
          },
        }}
      />
    </div>
    </MotionProvider>
  );
}
