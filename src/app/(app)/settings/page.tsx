import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { getAccountInfo, getUserShareLists } from "@/lib/data";
import { SettingsClient } from "./settings-client";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();
  const [info, shares] = await Promise.all([
    getAccountInfo(user.id),
    getUserShareLists(user.id),
  ]);
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>
      <SettingsClient info={info} shares={shares} />
    </div>
  );
}
