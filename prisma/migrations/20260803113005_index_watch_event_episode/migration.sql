-- Postgres does not index a foreign key automatically. WatchEvent.episodeId is
-- read without userId/titleId in the predicate by two paths that scale with the
-- entire watch log: un-ticking an episode looks its event up directly, and every
-- Episode deletion must locate referencing events to apply ON DELETE SET NULL.
-- Episode deletes are bulk operations (re-match, purge, empty trash), so without
-- this index each deleted row costs a full scan inside an interactive
-- transaction.

-- CreateIndex
CREATE INDEX "WatchEvent_episodeId_idx" ON "WatchEvent"("episodeId");
