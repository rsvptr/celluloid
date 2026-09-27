"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { requireUserId } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { isRecModel } from "@/lib/models";
import { setWatchRegion } from "@/lib/region-actions";
import { isWatchRegion } from "@/lib/tmdb-extras";

export interface ActionResult {
  ok?: boolean;
  error?: string;
}

/** True when `tz` is a real IANA time zone identifier. */
function isSupportedTimeZone(tz: string): boolean {
  // Intl.supportedValuesOf is the canonical source of truth, but guard its
  // availability — some runtimes/polyfills omit the enumeration API even
  // when Intl.DateTimeFormat itself works.
  if (typeof Intl.supportedValuesOf === "function") {
    try {
      return Intl.supportedValuesOf("timeZone").includes(tz);
    } catch {
      return false;
    }
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Server actions are public HTTP endpoints callable with arbitrary arguments,
// so every one of them validates its input before touching it. Without this a
// non-string argument turned `name.trim()` into an unhandled TypeError — a 500
// with a stack trace instead of the { error } contract the forms expect.
const profileSchema = z.object({ name: z.string().max(2000) });
const anthropicKeySchema = z.object({ key: z.string().max(2000) });
const recommendModelSchema = z.object({ model: z.string().max(200) });
const myProvidersSchema = z
  .array(z.number().int().positive().max(2_147_483_647))
  .max(100, "Choose no more than 100 services.");

const preferencesSchema = z.object({
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine(isSupportedTimeZone, "That doesn't look like a valid time zone."),
  watchRegion: z
    .string()
    .refine(isWatchRegion, "That doesn't look like a valid region."),
});

export async function updateProfile(name: string): Promise<ActionResult> {
  await requireUserId();
  const parsed = profileSchema.safeParse({ name });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const trimmed = parsed.data.name.trim().slice(0, 80);
  if (!trimmed) return { error: "Name can't be empty." };
  // Route the validated write through Better Auth so its session_data cookie
  // is refreshed immediately; a direct Prisma update leaves the old name in
  // the 60-second cookie cache used by the app shell.
  await auth.api.updateUser({
    headers: await headers(),
    body: { name: trimmed },
    // updateUser re-issues that cookie from whatever session authorized it.
    // Read the session row, not the cookie cache, so a session revoked on
    // another device can't keep itself alive by saving its name every minute.
    query: { disableCookieCache: true },
  });
  revalidatePath("/settings");
  return { ok: true };
}

export async function setAnthropicKey(key: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const parsed = anthropicKeySchema.safeParse({ key });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const k = parsed.data.key.trim();
  if (!k.startsWith("sk-ant-") || k.length > 256 || !/^[\w-]+$/.test(k)) {
    return { error: "That doesn't look like an Anthropic key (it should start with sk-ant-)." };
  }
  await prisma.user.update({
    where: { id: userId },
    data: { anthropicKeyEnc: encryptSecret(k) },
  });
  revalidatePath("/settings");
  revalidatePath("/recommend");
  return { ok: true };
}

export async function removeAnthropicKey(): Promise<ActionResult> {
  const userId = await requireUserId();
  await prisma.user.update({
    where: { id: userId },
    data: { anthropicKeyEnc: null },
  });
  revalidatePath("/settings");
  revalidatePath("/recommend");
  return { ok: true };
}

/** Saves the streaming services used by the library's "On my services" view. */
export async function updateMyProviders(providerIds: number[]): Promise<ActionResult> {
  const userId = await requireUserId();
  const parsed = myProvidersSchema.safeParse(providerIds);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Celluloid couldn't save your services. Refresh and try again.",
    };
  }

  // The UI behaves like a set, but the server action is public and may receive
  // duplicates or an arbitrary order. Canonicalize before persisting so dirty
  // checks and backups stay deterministic.
  const myProviders = [...new Set(parsed.data)].sort((a, b) => a - b);
  await prisma.user.update({ where: { id: userId }, data: { myProviders } });
  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true };
}

/** Sets (or clears, with "") the user's preferred recommendation model. */
export async function setRecommendModel(model: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const parsed = recommendModelSchema.safeParse({ model });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const m = parsed.data.model.trim();
  if (m && !isRecModel(m)) return { error: "That model isn't available. Choose one from the list." };
  await prisma.user.update({
    where: { id: userId },
    data: { recommendModel: m || null },
  });
  revalidatePath("/settings");
  revalidatePath("/recommend");
  return { ok: true };
}

/** Updates the signed-in user's time zone and default watch region. */
export async function updatePreferences(input: {
  timeZone: string;
  watchRegion: string;
}): Promise<ActionResult> {
  const userId = await requireUserId();
  const parsed = preferencesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Celluloid couldn't save your preferences. Check the values and retry.",
    };
  }
  await prisma.user.update({
    where: { id: userId },
    data: { timeZone: parsed.data.timeZone, watchRegion: parsed.data.watchRegion },
  });
  // The title page reads the per-device region cookie first and only falls back
  // to this saved value when the cookie is absent, so on the very browser where
  // the region was just changed — the one that already has a cookie from the
  // inline picker — Settings appeared to do nothing. Write the cookie through
  // setWatchRegion so the device the owner is looking at agrees with the
  // account default immediately, and so the cookie's name and options live in
  // exactly one place.
  await setWatchRegion(parsed.data.watchRegion);
  revalidatePath("/settings");
  revalidatePath("/stats");
  return { ok: true };
}
