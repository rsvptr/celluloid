-- WatchEvent is an append-only activity log used by stats, streaks, and
-- backups. Episode rows are replaceable TMDB metadata, so deleting an Episode
-- must detach the optional link rather than destroy the historical event.

-- DropForeignKey
ALTER TABLE "WatchEvent" DROP CONSTRAINT "WatchEvent_episodeId_fkey";

-- AddForeignKey
ALTER TABLE "WatchEvent" ADD CONSTRAINT "WatchEvent_episodeId_fkey"
FOREIGN KEY ("episodeId") REFERENCES "Episode"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
