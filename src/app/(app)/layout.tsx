import { requireUser } from "@/lib/session";
import { Nav } from "@/components/nav";
import { CommandPalette } from "@/components/command-palette";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  // The command palette fetches its title index lazily on first open, so the
  // layout doesn't run (and serialize) a whole-library query on every page.
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-brand"
      >
        Skip to content
      </a>
      <Nav userName={user.name} />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 outline-none">
        {children}
      </main>
      <CommandPalette />
    </div>
  );
}
