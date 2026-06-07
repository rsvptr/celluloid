import { requireUser } from "@/lib/session";
import { getTitleIndex } from "@/lib/data";
import { Nav } from "@/components/nav";
import { CommandPalette } from "@/components/command-palette";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const titles = await getTitleIndex(user.id);
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav userName={user.name} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      <CommandPalette titles={titles} />
    </div>
  );
}
