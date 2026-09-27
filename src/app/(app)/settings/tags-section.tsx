"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil, Tag as TagIcon } from "lucide-react";
import { Badge, Button, Card, Input, Spinner, softDisabledClass } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { deleteTag, renameTag, setTagColor } from "@/lib/actions";
import {
  TAG_COLORS,
  TAG_COLOR_DEFAULT_SWATCH,
  TAG_COLOR_META,
  tagChipClass,
  tagColorKey,
} from "@/lib/tag-colors";
import { Notice, Section } from "./settings-ui";

/** One row of the tag manager: the tag plus how many live titles carry it. */
export interface TagSummary {
  id: string;
  name: string;
  color: string | null;
  count: number;
}

export function TagsSection({ tags }: { tags: TagSummary[] }) {
  const { confirm, dialog } = useConfirm();
  const [deleting, setDeleting] = useState<string | null>(null);

  async function remove(tag: TagSummary) {
    if (
      !(await confirm({
        title: `Delete the “${tag.name}” tag?`,
        body:
          tag.count === 0
            ? "It isn't on any titles, so nothing else changes."
            : `It will be removed from ${tag.count} ${tag.count === 1 ? "title" : "titles"}. Those titles keep everything else.`,
        confirmLabel: "Delete tag",
        destructive: true,
      }))
    )
      return;
    setDeleting(tag.id);
    try {
      const res = await deleteTag(tag.id);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`Deleted the “${tag.name}” tag`);
      // The row, and the Delete button that had focus, are gone.
      document.getElementById("settings-tags-heading")?.focus();
    } catch {
      toast.error("Couldn't delete that tag. Try again.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <>
      {dialog}
      <Section
        icon={TagIcon}
        title="Tags"
        headingId="settings-tags-heading"
        description="Rename a tag without losing what it's on, give it a colour, or delete it."
      >
        {tags.length === 0 ? (
          <p className="text-sm text-muted">
            No tags yet. Add one from a title page, or from the Library&apos;s
            selection bar.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {tags.map((tag) => (
              // Re-keyed on the editable fields so a refresh replaces the row's
              // draft rather than leaving an edited name over stale server data.
              <TagRow
                key={`${tag.id}:${tag.name}:${tag.color ?? ""}`}
                tag={tag}
                deleting={deleting === tag.id}
                onDelete={() => remove(tag)}
              />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function TagRow({
  tag,
  deleting,
  onDelete,
}: {
  tag: TagSummary;
  deleting: boolean;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  // A colour from the first palette shows as the palette colour it renders as.
  const storedColor = tagColorKey(tag.color);
  const [color, setColor] = useState<string | null>(storedColor);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const dirty = name.trim() !== tag.name || color !== storedColor;

  function cancel() {
    setEditing(false);
    setName(tag.name);
    setColor(storedColor);
    setError(null);
  }

  function save() {
    start(async () => {
      setError(null);
      try {
        // Rename first: it's the change that can be refused (the name may be
        // taken), so a refusal leaves the tag exactly as it was rather than
        // half-recoloured.
        if (name.trim() !== tag.name) {
          const res = await renameTag(tag.id, name);
          if (res.error) {
            setError(res.error);
            return;
          }
        }
        if (color !== storedColor) {
          const res = await setTagColor(tag.id, color);
          if (res.error) {
            setError(res.error);
            return;
          }
        }
        setEditing(false);
        toast.success("Tag updated");
      } catch {
        setError("Couldn't update that tag. Try again.");
      }
    });
  }

  return (
    <li className="flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Badge className={tagChipClass(tag.color)}>{tag.name}</Badge>
          <span className="shrink-0 text-xs tabular-nums text-faint">
            {tag.count} {tag.count === 1 ? "title" : "titles"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={editing}
            disabled={busy || deleting}
            onClick={() => (editing ? cancel() : setEditing(true))}
          >
            <Pencil aria-hidden="true" size={16} />
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("text-rose-300 hover:text-rose-200", softDisabledClass)}
            aria-disabled={busy || deleting}
            onClick={() => {
              if (busy || deleting) return;
              onDelete();
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>

      {editing && (
        <Card variant="inset" className="flex flex-col gap-3 p-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Name</span>
            <Input
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              className="w-full"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Colour</span>
            <div role="group" aria-label="Tag colour" className="flex flex-wrap gap-1.5">
              <ColorSwatch
                label="No colour"
                swatch={TAG_COLOR_DEFAULT_SWATCH}
                selected={color === null}
                onSelect={() => setColor(null)}
              />
              {TAG_COLORS.map((c) => (
                <ColorSwatch
                  key={c}
                  label={TAG_COLOR_META[c].label}
                  swatch={TAG_COLOR_META[c].swatch}
                  selected={color === c}
                  onSelect={() => setColor(c)}
                />
              ))}
            </div>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !dirty || !name.trim()}
              onClick={save}
            >
              {busy ? <Spinner /> : null} Save
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </li>
  );
}

function ColorSwatch({
  label,
  swatch,
  selected,
  onSelect,
}: {
  label: string;
  swatch: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      className={cn(
        "focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-colors sm:min-h-9 sm:min-w-9",
        selected ? "bg-surface-2 ring-1 ring-brand/50" : "hover:bg-surface-2/60",
      )}
    >
      <span aria-hidden="true" className={cn("h-4 w-4 rounded-full ring-1", swatch)} />
    </button>
  );
}
