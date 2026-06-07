"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Heart, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { WatchStatus } from "@/generated/prisma/client";
import { Button, Card, Select, Textarea } from "@/components/ui";
import { RatingStars } from "@/components/rating-stars";
import { useConfirm } from "@/components/confirm-dialog";
import { STATUS_META, STATUS_ORDER } from "@/lib/format";
import { removeTitle, updateTitle } from "@/lib/actions";
import { cn } from "@/lib/utils";

export function TitleControls({
  id,
  status,
  rating,
  notes,
  favorite,
  watchedAt,
}: {
  id: string;
  status: WatchStatus;
  rating: number | null;
  notes: string | null;
  favorite: boolean;
  watchedAt: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { confirm, dialog } = useConfirm();

  const [localStatus, setLocalStatus] = useState(status);
  const [localRating, setLocalRating] = useState(rating);
  const [localFav, setLocalFav] = useState(favorite);
  const [localWatchedAt, setLocalWatchedAt] = useState(watchedAt?.slice(0, 10) ?? "");
  const [localNotes, setLocalNotes] = useState(notes ?? "");
  const [savedNotes, setSavedNotes] = useState(notes ?? "");

  function save(patch: Parameters<typeof updateTitle>[1]) {
    startTransition(async () => {
      await updateTitle(id, patch);
      router.refresh();
    });
  }

  return (
    <>
      {dialog}
      <Card className="flex flex-col gap-5 p-5">
      <Field label="Status">
        <Select
          value={localStatus}
          onChange={(e) => {
            const v = e.target.value as WatchStatus;
            setLocalStatus(v);
            save({ status: v });
          }}
          className="w-full"
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Your rating">
        <RatingStars
          value={localRating}
          onChange={(v) => {
            setLocalRating(v);
            save({ rating: v });
          }}
        />
      </Field>

      <Field label="Date watched">
        <input
          type="date"
          value={localWatchedAt}
          onChange={(e) => {
            setLocalWatchedAt(e.target.value);
            save({ watchedAt: e.target.value || null });
          }}
          className="h-10 w-full rounded-lg bg-surface-2 px-3 text-sm text-foreground ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand/60 [color-scheme:dark]"
        />
      </Field>

      <Field label="Notes">
        <Textarea
          value={localNotes}
          onChange={(e) => setLocalNotes(e.target.value)}
          placeholder="Private notes. Handy context to feed an AI later."
          rows={4}
          maxLength={2000}
        />
        {localNotes.length > 1800 && (
          <p className="mt-1 text-right text-xs text-faint">
            {localNotes.length}/2000
          </p>
        )}
        {localNotes !== savedNotes && (
          <Button
            size="sm"
            variant="secondary"
            className="mt-2 self-start"
            disabled={isPending}
            onClick={() => {
              const next = localNotes;
              startTransition(async () => {
                try {
                  await updateTitle(id, { notes: next });
                  setSavedNotes(next);
                  toast.success("Notes saved");
                  router.refresh();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              });
            }}
          >
            Save notes
          </Button>
        )}
      </Field>

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button
          variant={localFav ? "primary" : "secondary"}
          size="sm"
          onClick={() => {
            const v = !localFav;
            setLocalFav(v);
            save({ favorite: v });
          }}
        >
          <Heart size={15} className={cn(localFav && "fill-current")} />
          {localFav ? "Favorited" : "Favorite"}
        </Button>
        <Button
          variant="danger"
          size="sm"
          className="ml-auto"
          onClick={async () => {
            if (
              !(await confirm({
                title: "Remove this title?",
                body: "It'll be removed from your library, along with any episode progress.",
                confirmLabel: "Remove",
                destructive: true,
              }))
            )
              return;
            startTransition(async () => {
              await removeTitle(id);
              router.push("/");
              router.refresh();
            });
          }}
        >
          <Trash2 size={15} />
          Remove
        </Button>
      </div>
      </Card>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      <span
        id={labelId}
        className="text-xs font-medium uppercase tracking-wide text-faint"
      >
        {label}
      </span>
      {children}
    </div>
  );
}
