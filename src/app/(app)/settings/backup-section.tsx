"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArchiveRestore, Download, Upload } from "lucide-react";
import { Button, Input, Select, Spinner, softDisabledClass } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { fullDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { saveBlob } from "@/lib/save-blob";
import { Notice, Section } from "./settings-ui";

type RestorePreview = {
  create: number;
  update: number;
  skip: number;
  conflict: number;
  suppressionsCreate: number;
  suppressionsUpdate: number;
  suppressionsSkip: number;
  providerSelections: number;
  providerPreferenceIncluded: number;
  providerPreferenceUpdate: number;
  recommendModelPreferenceIncluded: number;
  recommendModelPreferenceUpdate: number;
  confirmationToken: string;
};

type RestoreResult = Omit<RestorePreview, "confirmationToken"> & {
  sharesCreated: number;
  sharesSkipped: number;
  eventsCreated: number;
  eventsSkipped: number;
};

/** A backup older than this is called out. One month of watches is a real loss. */
const STALE_BACKUP_DAYS = 30;

/**
 * How stale the off-site copy is. `ageDays` is measured on the server rather
 * than here: "now" would otherwise be read at two different instants (the
 * server render and hydration), and a day boundary falling between them would
 * be a mismatch on the one line whose whole job is to be trustworthy.
 */
function BackupFreshness({
  lastBackupAt,
  ageDays,
}: {
  lastBackupAt: string | null;
  ageDays: number | null;
}) {
  if (!lastBackupAt || ageDays === null) {
    return (
      <p role="status" className="text-xs text-amber-200">
        No backup downloaded yet. This file is the only copy of your history that
        lives outside the app.
      </p>
    );
  }

  const relative =
    ageDays <= 0 ? "today" : ageDays === 1 ? "yesterday" : `${ageDays} days ago`;
  const stale = ageDays >= STALE_BACKUP_DAYS;

  return (
    <p role="status" className={cn("text-xs", stale ? "text-amber-200" : "text-muted")}>
      Last backup {fullDate(lastBackupAt)} ({relative}).
      {stale
        ? " Anything you have watched, rated or noted since then isn't in it."
        : ""}
    </p>
  );
}

export function BackupSection({
  lastBackupAt,
  backupAgeDays,
}: {
  lastBackupAt: string | null;
  backupAgeDays: number | null;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"merge" | "replace-personal">("merge");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"download" | "preview" | "restore" | null>(null);

  function resetPreview() {
    setPreview(null);
    setResult(null);
    setError(null);
  }

  async function downloadBackup() {
    setBusy("download");
    setError(null);
    try {
      const response = await fetch("/api/backup", { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error || "Celluloid couldn't create the backup. Try again.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ?? "celluloid-backup.json";
      saveBlob(blob, filename);
      toast.success("Backup downloaded");
      // Pull the freshness line back from the server, which has just stamped it.
      router.refresh();
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Celluloid couldn't create the backup. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function sendRestore(dryRun: boolean, confirmationToken?: string) {
    if (!file) throw new Error("Choose a backup file first.");
    const form = new FormData();
    form.set("file", file);
    form.set("mode", mode);
    form.set("dryRun", String(dryRun));
    if (confirmationToken) form.set("confirmationToken", confirmationToken);

    const response = await fetch("/api/backup/restore", {
      method: "POST",
      body: form,
    });
    const body = (await response.json().catch(() => null)) as
      | (Partial<RestorePreview & RestoreResult> & { error?: string })
      | null;
    if (!response.ok || !body) {
      throw new Error(
        body?.error || "Celluloid couldn't read that backup. Check the file and try again.",
      );
    }
    return body;
  }

  async function previewRestore() {
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const body = await sendRestore(true);
      if (
        typeof body.create !== "number" ||
        typeof body.update !== "number" ||
        typeof body.skip !== "number" ||
        typeof body.conflict !== "number" ||
        typeof body.suppressionsCreate !== "number" ||
        typeof body.suppressionsUpdate !== "number" ||
        typeof body.suppressionsSkip !== "number" ||
        typeof body.providerSelections !== "number" ||
        typeof body.providerPreferenceIncluded !== "number" ||
        typeof body.providerPreferenceUpdate !== "number" ||
        typeof body.recommendModelPreferenceIncluded !== "number" ||
        typeof body.recommendModelPreferenceUpdate !== "number" ||
        typeof body.confirmationToken !== "string"
      ) {
        throw new Error("Celluloid returned an incomplete restore preview. Try again.");
      }
      setPreview({
        create: body.create,
        update: body.update,
        skip: body.skip,
        conflict: body.conflict,
        suppressionsCreate: body.suppressionsCreate,
        suppressionsUpdate: body.suppressionsUpdate,
        suppressionsSkip: body.suppressionsSkip,
        providerSelections: body.providerSelections,
        providerPreferenceIncluded: body.providerPreferenceIncluded,
        providerPreferenceUpdate: body.providerPreferenceUpdate,
        recommendModelPreferenceIncluded: body.recommendModelPreferenceIncluded,
        recommendModelPreferenceUpdate: body.recommendModelPreferenceUpdate,
        confirmationToken: body.confirmationToken,
      });
    } catch (previewError) {
      setPreview(null);
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Celluloid couldn't preview that backup. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function commitRestore() {
    if (!preview) return;
    const hiddenSuggestionWrites =
      preview.suppressionsCreate + preview.suppressionsUpdate;
    const providerCopy = !preview.providerPreferenceIncluded
      ? "This older file has no selected-service data."
      : preview.providerPreferenceUpdate
        ? `It will restore ${preview.providerSelections} selected ${preview.providerSelections === 1 ? "service" : "services"}.`
        : "The current selected services will stay unchanged.";
    const recommendModelCopy = !preview.recommendModelPreferenceIncluded
      ? "It has no recommendation-model preference."
      : preview.recommendModelPreferenceUpdate
        ? "It will restore the recommendation-model preference."
        : "The current recommendation model will stay unchanged.";
    const approved = await confirm({
      title: "Restore this backup?",
      body: `This will create ${preview.create} and update ${preview.update} titles, and restore ${hiddenSuggestionWrites} hidden ${hiddenSuggestionWrites === 1 ? "suggestion" : "suggestions"}. ${providerCopy} ${recommendModelCopy} Existing titles not included in the backup stay untouched. Restored shared lists receive new private links.`,
      confirmLabel: "Restore backup",
      destructive: mode === "replace-personal",
    });
    if (!approved) return;

    setBusy("restore");
    setError(null);
    try {
      const body = await sendRestore(false, preview.confirmationToken);
      if (
        typeof body.create !== "number" ||
        typeof body.update !== "number" ||
        typeof body.skip !== "number" ||
        typeof body.conflict !== "number" ||
        typeof body.suppressionsCreate !== "number" ||
        typeof body.suppressionsUpdate !== "number" ||
        typeof body.suppressionsSkip !== "number" ||
        typeof body.providerSelections !== "number" ||
        typeof body.providerPreferenceIncluded !== "number" ||
        typeof body.providerPreferenceUpdate !== "number" ||
        typeof body.recommendModelPreferenceIncluded !== "number" ||
        typeof body.recommendModelPreferenceUpdate !== "number" ||
        typeof body.sharesCreated !== "number" ||
        typeof body.sharesSkipped !== "number" ||
        typeof body.eventsCreated !== "number" ||
        typeof body.eventsSkipped !== "number"
      ) {
        throw new Error("Celluloid returned an incomplete restore result. Refresh and check your library.");
      }
      const restored: RestoreResult = {
        create: body.create,
        update: body.update,
        skip: body.skip,
        conflict: body.conflict,
        suppressionsCreate: body.suppressionsCreate,
        suppressionsUpdate: body.suppressionsUpdate,
        suppressionsSkip: body.suppressionsSkip,
        providerSelections: body.providerSelections,
        providerPreferenceIncluded: body.providerPreferenceIncluded,
        providerPreferenceUpdate: body.providerPreferenceUpdate,
        recommendModelPreferenceIncluded: body.recommendModelPreferenceIncluded,
        recommendModelPreferenceUpdate: body.recommendModelPreferenceUpdate,
        sharesCreated: body.sharesCreated,
        sharesSkipped: body.sharesSkipped,
        eventsCreated: body.eventsCreated,
        eventsSkipped: body.eventsSkipped,
      };
      // The preview, and the Restore button that had focus, give way to the
      // result.
      flushSync(() => {
        setResult(restored);
        setPreview(null);
      });
      document.getElementById("settings-restore-result")?.focus();
      toast.success("Backup restored");
      router.refresh();
    } catch (restoreError) {
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : "Celluloid couldn't restore that backup. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {dialog}
      <Section
        icon={ArchiveRestore}
        title="Backup"
        description="Download a current v2 copy, or restore a Celluloid v1 or v2 backup."
      >
        <div className="flex flex-col gap-4">
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={downloadBackup}
            >
              {busy === "download" ? <Spinner /> : <Download aria-hidden="true" size={16} />}
              {busy === "download" ? "Preparing backup\u2026" : "Download backup"}
            </Button>
            <div className="mt-2">
              <BackupFreshness lastBackupAt={lastBackupAt} ageDays={backupAgeDays} />
            </div>
            <p className="mt-2 text-xs text-muted">
              Includes active and trashed titles, watch history, ratings, notes, tags, TV
              progress, selected services, recommendation preferences, hidden suggestions,
              and share settings. Passwords, sessions, API keys, 2FA secrets, and live share
              URLs are excluded.
            </p>
          </div>

          <div className="border-t border-line pt-4">
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">Backup file</span>
                <Input
                  name="celluloid-backup"
                  type="file"
                  accept="application/json,.json"
                  className="h-auto min-h-11 py-2 file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-2 file:py-1 file:text-xs file:font-medium file:text-foreground"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    resetPreview();
                  }}
                />
              </label>
              <p className="text-xs text-faint">Celluloid v1 or v2 JSON, up to 4 MB.</p>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">Restore mode</span>
                <Select
                  name="backup-restore-mode"
                  value={mode}
                  className="w-full"
                  onChange={(event) => {
                    setMode(event.target.value as "merge" | "replace-personal");
                    resetPreview();
                  }}
                >
                  <option value="merge">Merge without replacing personal data</option>
                  <option value="replace-personal">Use backup personal data</option>
                </Select>
              </label>
              <p className="text-xs text-muted">
                {mode === "merge"
                  ? "Merge adds missing titles and fills empty ratings, notes, and dates. Current status, favorites, progress, and existing tags stay in place."
                  : "The backup replaces status, ratings, notes, dates, favorites, tags, and episode progress for matching titles. Other titles stay in place."}
              </p>

              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="self-start"
                disabled={!file || busy !== null}
                onClick={previewRestore}
              >
                {busy === "preview" ? <Spinner /> : <Upload aria-hidden="true" size={16} />}
                {busy === "preview" ? "Checking backup\u2026" : "Preview restore"}
              </Button>
            </div>
          </div>

          {preview ? (
            <div className="rounded-lg bg-surface-2 p-3 ring-1 ring-line" aria-live="polite">
              <p className="text-xs font-medium text-foreground">Restore preview</p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs tabular-nums">
                <div>
                  <dt className="text-muted">Create</dt>
                  <dd className="font-medium">{preview.create}</dd>
                </div>
                <div>
                  <dt className="text-muted">Update</dt>
                  <dd className="font-medium">{preview.update}</dd>
                </div>
                <div>
                  <dt className="text-muted">Unchanged</dt>
                  <dd className="font-medium">{preview.skip}</dd>
                </div>
                <div>
                  <dt className="text-muted">Conflicts</dt>
                  <dd className="font-medium text-amber-300">{preview.conflict}</dd>
                </div>
                <div>
                  <dt className="text-muted">Hidden suggestions</dt>
                  <dd className="font-medium">
                    {preview.suppressionsCreate + preview.suppressionsUpdate}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Already hidden</dt>
                  <dd className="font-medium">{preview.suppressionsSkip}</dd>
                </div>
                <div>
                  <dt className="text-muted">Selected services</dt>
                  <dd className="font-medium">
                    {preview.providerPreferenceIncluded
                      ? `${preview.providerSelections} · ${preview.providerPreferenceUpdate ? "Restore" : "Keep current"}`
                      : "Not in file"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Recommendation model</dt>
                  <dd className="font-medium">
                    {preview.recommendModelPreferenceIncluded
                      ? preview.recommendModelPreferenceUpdate
                        ? "Restore"
                        : "Keep current"
                      : "Not in file"}
                  </dd>
                </div>
              </dl>
              {preview.conflict > 0 ? (
                <p className="mt-2 text-xs text-amber-200">
                  Conflicting titles are skipped. The rest can still be restored.
                </p>
              ) : null}
              <Button
                type="button"
                variant={mode === "replace-personal" ? "danger" : "primary"}
                size="sm"
                className={cn("mt-3", softDisabledClass)}
                aria-disabled={busy !== null}
                onClick={() => {
                  if (busy !== null) return;
                  void commitRestore();
                }}
              >
                {busy === "restore" ? <Spinner /> : <ArchiveRestore aria-hidden="true" size={16} />}
                {busy === "restore" ? "Restoring\u2026" : "Restore backup"}
              </Button>
            </div>
          ) : null}

          {result ? (
            <Notice kind="ok" focusId="settings-restore-result">
              Restored {result.create} new and {result.update} existing titles. Skipped {result.skip}
              {result.conflict > 0 ? `, with ${result.conflict} conflicts` : ""}. Created {result.sharesCreated}
              {result.sharesCreated === 1 ? " share link" : " share links"}.
              {result.sharesSkipped > 0
                ? ` Recognized ${result.sharesSkipped} already-restored share ${result.sharesSkipped === 1 ? "link" : "links"}.`
                : ""}
              {" "}Restored {result.eventsCreated} watch
              {result.eventsCreated === 1 ? " event" : " events"}.
              {result.eventsSkipped > 0
                ? ` Recognized ${result.eventsSkipped} already-restored watch ${result.eventsSkipped === 1 ? "event" : "events"}.`
                : ""}
              {" "}Restored {result.suppressionsCreate + result.suppressionsUpdate} hidden
              {result.suppressionsCreate + result.suppressionsUpdate === 1 ? " suggestion" : " suggestions"}.
              {result.suppressionsSkip > 0
                ? ` Recognized ${result.suppressionsSkip} already-recorded hidden ${result.suppressionsSkip === 1 ? "suggestion" : "suggestions"}.`
                : ""}
              {result.providerPreferenceIncluded
                ? result.providerPreferenceUpdate
                  ? ` Restored ${result.providerSelections} selected ${result.providerSelections === 1 ? "service" : "services"}.`
                  : " Kept the current selected services."
                : ""}
              {result.recommendModelPreferenceIncluded
                ? result.recommendModelPreferenceUpdate
                  ? " Restored the recommendation-model preference."
                  : " Kept the current recommendation model."
                : ""}
            </Notice>
          ) : null}
          {error ? <Notice kind="error">{error}</Notice> : null}
        </div>
      </Section>
    </>
  );
}
