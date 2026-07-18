"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { isRecModel } from "@/lib/models";
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
  const userId = await requireUserId();
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return { error: "Name can't be empty." };
  await prisma.user.update({ where: { id: userId }, data: { name: trimmed } });
  revalidatePath("/settings");
  return { ok: true };
}

export async function setAnthropicKey(key: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const k = key.trim();
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

/** Sets (or clears, with "") the user's preferred recommendation model. */
export async function setRecommendModel(model: string): Promise<ActionResult> {
  const userId = await requireUserId();
  const m = model.trim();
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
  revalidatePath("/settings");
  revalidatePath("/stats");
  return { ok: true };
}
