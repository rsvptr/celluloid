import { Toaster } from "sonner";
import { requireUser } from "@/lib/session";
import { Nav } from "@/components/nav";
import { MotionProvider } from "@/components/motion";
import { LazyCommandPalette } from "@/components/command-palette-lazy";

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
          inset) so the last row of content is never hidden behind it; md+
          reverts to the original symmetric py-6 since that bar is desktop-hidden. */}
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-[calc(5rem+env(safe-area-inset-bottom))] outline-none md:pb-6"
      >
        {children}
      </main>
      <LazyCommandPalette />
      <Toaster
        theme="dark"
        richColors
        position="bottom-right"
        mobileOffset={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom))" }}
        toastOptions={{
          style: {
            background: "var(--color-surface)",
            border: "1px solid var(--color-line)",
            color: "var(--color-foreground)",
          },
          classNames: {
            actionButton: "min-h-11 sm:min-h-0",
          },
        }}
      />
    </div>
    </MotionProvider>
  );
}
