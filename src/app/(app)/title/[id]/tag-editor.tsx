"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Tag as TagIcon, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui";
import { createTag, toggleTitleTag } from "@/lib/actions";

interface TagVM {
  id: string;
  name: string;
}

export function TagEditor({
  titleId,
  current,
  all,
}: {
  titleId: string;
  current: TagVM[];
  all: TagVM[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tags, setTags] = useState<TagVM[]>(current);
  const [input, setInput] = useState("");
  const captionId = useId();

  const appliedIds = new Set(tags.map((t) => t.id));
  const suggestions = all.filter((t) => !appliedIds.has(t.id));

  function apply(tag: TagVM) {
    setTags((t) => [...t, tag]);
    startTransition(async () => {
      try {
        const res = await toggleTitleTag(titleId, tag.id, true);
        if (res.error) {
          setTags((t) => t.filter((x) => x.id !== tag.id));
          toast.error(res.error);
          return;
        }
        router.refresh();
      } catch {
        setTags((t) => t.filter((x) => x.id !== tag.id)); // roll back optimistic add
        toast.error(`Couldn't add “${tag.name}”. Please try again.`);
      }
    });
  }

  function remove(tag: TagVM) {
    setTags((t) => t.filter((x) => x.id !== tag.id));
    startTransition(async () => {
      try {
        const res = await toggleTitleTag(titleId, tag.id, false);
        if (res.error) {
          setTags((t) => [...t, tag]);
          toast.error(res.error);
          return;
        }
        router.refresh();
      } catch {
        setTags((t) => [...t, tag]); // roll back optimistic remove
        toast.error(`Couldn't remove “${tag.name}”. Please try again.`);
      }
    });
  }

  function add(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setInput("");
    const existing = all.find(
      (t) => t.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) {
      if (!appliedIds.has(existing.id)) apply(existing);
      return;
    }
    startTransition(async () => {
      // No optimistic chip here, unlike apply/remove: a brand-new tag has no id
      // until the server mints one, so there is nothing to render — and nothing
      // to roll back — until both calls land. The two are reported separately
      // because creating the tag can succeed while linking it to this title
      // fails, and the chip must not appear for a link that was never made.
      let id: string;
      try {
        const createResult = await createTag(trimmed);
        if (createResult.error || !createResult.id) {
          toast.error(createResult.error ?? `Couldn't create “${trimmed}”. Please try again.`);
          return;
        }
        id = createResult.id;
      } catch {
        toast.error(`Couldn't create “${trimmed}”. Please try again.`);
        return;
      }
      try {
        const toggleResult = await toggleTitleTag(titleId, id, true);
        if (toggleResult.error) {
          toast.error(toggleResult.error);
          return;
        }
      } catch {
        toast.error(`Couldn't add “${trimmed}”. Please try again.`);
        return;
      }
      setTags((t) => [...t, { id, name: trimmed }]);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <span
        id={captionId}
        className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-faint"
      >
        <TagIcon size={12} /> Tags & lists
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span
            key={t.id}
            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-foreground ring-1 ring-line"
          >
            <span className="break-words">{t.name}</span>
            <button
              onClick={() => remove(t)}
              className="focus-ring -m-1.5 rounded p-1.5 text-faint hover:text-rose-300 sm:m-0 sm:p-0"
              aria-label={`Remove ${t.name}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {tags.length === 0 && (
          <span className="text-xs text-faint">No tags yet</span>
        )}
      </div>

      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          add(input);
        }}
        className="flex items-center gap-2"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Add a tag (e.g. Horror night)…"
          list="tag-suggestions"
          maxLength={50}
          aria-labelledby={captionId}
          className="h-11 sm:h-9"
        />
        <datalist id="tag-suggestions">
          {suggestions.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
        <button
          type="submit"
          className="focus-ring flex h-9 min-h-11 w-9 min-w-11 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted ring-1 ring-line hover:text-foreground sm:min-h-0 sm:min-w-0"
          aria-label="Add tag"
        >
          <Plus size={16} />
        </button>
      </form>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.slice(0, 8).map((t) => (
            <button
              key={t.id}
              onClick={() => apply(t)}
              className="focus-ring flex min-h-11 items-center rounded-full px-2 py-0.5 text-xs text-muted ring-1 ring-line hover:text-foreground sm:min-h-0"
            >
              + {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
