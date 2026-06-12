"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { isRecModel } from "@/lib/models";

export interface ActionResult {
  ok?: boolean;
  error?: string;
}

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
  if (m && !isRecModel(m)) return { error: "Unknown model." };
  await prisma.user.update({
    where: { id: userId },
    data: { recommendModel: m || null },
  });
  revalidatePath("/settings");
  revalidatePath("/recommend");
  return { ok: true };
}
