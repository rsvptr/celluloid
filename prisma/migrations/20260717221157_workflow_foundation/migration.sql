-- CreateEnum
CREATE TYPE "WatchEventKind" AS ENUM ('TITLE_COMPLETED', 'EPISODE_WATCHED', 'REWATCH');

-- CreateEnum
CREATE TYPE "WatchEventSource" AS ENUM ('MANUAL', 'BULK', 'IMPORT', 'RESTORE', 'BACKFILL');

-- CreateEnum
CREATE TYPE "MetadataSyncState" AS ENUM ('OK', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('PARSING', 'READY_FOR_REVIEW', 'COMMITTING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportItemAction" AS ENUM ('CREATE', 'UPDATE', 'SKIP', 'CONFLICT', 'FAILED');

-- CreateEnum
CREATE TYPE "ShareScope" AS ENUM ('WHOLE_LIBRARY', 'SELECTION');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN     "watchRegion" TEXT NOT NULL DEFAULT 'US';

-- AlterTable
ALTER TABLE "ShareList" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "scope" "ShareScope" NOT NULL DEFAULT 'SELECTION';

-- AlterTable
ALTER TABLE "Title" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "metadataLastError" TEXT,
ADD COLUMN     "metadataSyncState" "MetadataSyncState",
ADD COLUMN     "metadataSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Episode" ADD COLUMN     "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "WatchEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "episodeId" TEXT,
    "kind" "WatchEventKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" "WatchEventSource" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" "ImportJobStatus" NOT NULL,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB NOT NULL,
    "proposedTmdbId" INTEGER,
    "proposedMediaType" "MediaType",
    "matchScore" DOUBLE PRECISION,
    "action" "ImportItemAction" NOT NULL,
    "titleId" TEXT,
    "errorCode" TEXT,
    "warning" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ImportItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareListItem" (
    "id" TEXT NOT NULL,
    "shareListId" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ShareListItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WatchEvent_userId_occurredAt_idx" ON "WatchEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "WatchEvent_titleId_occurredAt_idx" ON "WatchEvent"("titleId", "occurredAt");

-- CreateIndex
CREATE INDEX "ImportJob_userId_createdAt_idx" ON "ImportJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportItem_titleId_idx" ON "ImportItem"("titleId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportItem_jobId_rowNumber_key" ON "ImportItem"("jobId", "rowNumber");

-- CreateIndex
CREATE INDEX "ShareListItem_titleId_idx" ON "ShareListItem"("titleId");

-- CreateIndex
CREATE UNIQUE INDEX "ShareListItem_shareListId_titleId_key" ON "ShareListItem"("shareListId", "titleId");

-- CreateIndex
CREATE INDEX "Title_userId_deletedAt_idx" ON "Title"("userId", "deletedAt");

-- AddForeignKey
ALTER TABLE "WatchEvent" ADD CONSTRAINT "WatchEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchEvent" ADD CONSTRAINT "WatchEvent_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "Title"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchEvent" ADD CONSTRAINT "WatchEvent_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "Title"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareListItem" ADD CONSTRAINT "ShareListItem_shareListId_fkey" FOREIGN KEY ("shareListId") REFERENCES "ShareList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareListItem" ADD CONSTRAINT "ShareListItem_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "Title"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data backfill + integrity hardening (hand-written; not representable in PSL)
-- ---------------------------------------------------------------------------

-- Backfill ShareList.scope: a whole-library share is one whose legacy titleIds
-- array is empty (the previous "empty = whole library" convention).
UPDATE "ShareList" SET "scope" = 'WHOLE_LIBRARY' WHERE cardinality("titleIds") = 0;

-- Backfill ShareListItem from the legacy titleIds arrays, preserving order via
-- WITH ORDINALITY (position = 1-based array ordinality). Join Title so only
-- titles that still exist are carried over.
INSERT INTO "ShareListItem" ("id", "shareListId", "titleId", "position")
SELECT gen_random_uuid()::text, sl."id", elem.title_id, elem.ord::int
FROM "ShareList" sl
CROSS JOIN LATERAL unnest(sl."titleIds") WITH ORDINALITY AS elem(title_id, ord)
JOIN "Title" t ON t."id" = elem.title_id;

-- Backfill WatchEvent from trustworthy existing timestamps.
-- (1) One TITLE_COMPLETED per Title that has a watchedAt.
INSERT INTO "WatchEvent" ("id", "userId", "titleId", "kind", "occurredAt", "source", "createdAt")
SELECT gen_random_uuid()::text, t."userId", t."id", 'TITLE_COMPLETED', t."watchedAt", 'BACKFILL', now()
FROM "Title" t
WHERE t."watchedAt" IS NOT NULL;

-- (2) One EPISODE_WATCHED per watched Episode that has a watchedAt; the owning
--     title and user are resolved through the episode's season.
INSERT INTO "WatchEvent" ("id", "userId", "titleId", "episodeId", "kind", "occurredAt", "source", "createdAt")
SELECT gen_random_uuid()::text, t."userId", t."id", e."id", 'EPISODE_WATCHED', e."watchedAt", 'BACKFILL', now()
FROM "Episode" e
JOIN "Season" s ON s."id" = e."seasonId"
JOIN "Title" t ON t."id" = s."titleId"
WHERE e."watched" = true AND e."watchedAt" IS NOT NULL;

-- CHECK constraints (existing data pre-verified clean by scripts/db-check.mjs).
ALTER TABLE "Title" ADD CONSTRAINT "Title_rating_domain_check" CHECK ("rating" IS NULL OR ("rating" >= 0.5 AND "rating" <= 10 AND "rating" * 2 = floor("rating" * 2)));
ALTER TABLE "Title" ADD CONSTRAINT "Title_watchedEpisodes_nonneg_check" CHECK ("watchedEpisodes" >= 0);
ALTER TABLE "Title" ADD CONSTRAINT "Title_totalEpisodes_nonneg_check" CHECK ("totalEpisodes" IS NULL OR "totalEpisodes" >= 0);
ALTER TABLE "Title" ADD CONSTRAINT "Title_totalSeasons_nonneg_check" CHECK ("totalSeasons" IS NULL OR "totalSeasons" >= 0);
ALTER TABLE "Title" ADD CONSTRAINT "Title_watched_le_total_check" CHECK ("totalEpisodes" IS NULL OR "watchedEpisodes" <= "totalEpisodes");
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_episodeNumber_nonneg_check" CHECK ("episodeNumber" >= 0);
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_runtime_nonneg_check" CHECK ("runtime" IS NULL OR "runtime" >= 0);
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_watched_date_check" CHECK ("watched" = true OR "watchedAt" IS NULL);
ALTER TABLE "Season" ADD CONSTRAINT "Season_seasonNumber_nonneg_check" CHECK ("seasonNumber" >= 0);

-- Case-insensitive unique tag names per user (functional index; not
-- representable in PSL, complements the existing "Tag_userId_name_key").
CREATE UNIQUE INDEX "Tag_userId_lower_name_key" ON "Tag" ("userId", lower("name"));
