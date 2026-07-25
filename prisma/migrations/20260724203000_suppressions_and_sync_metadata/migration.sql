-- Suppressed recommendations, backup freshness, provider preferences, and the
-- TV lifecycle/provider fields the scheduled metadata sync maintains.
--
-- Every column is nullable or defaulted, and the new table is additive, so this
-- migration is safe to apply to a populated database with no backfill.

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('NOT_INTERESTED', 'SEEN_ELSEWHERE');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "lastBackupAt" TIMESTAMP(3),
                   ADD COLUMN     "myProviders" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "Title" ADD COLUMN     "tmdbStatus" TEXT,
                    ADD COLUMN     "nextEpisodeAirDate" DATE,
                    ADD COLUMN     "streamProviderIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
                    ADD COLUMN     "providersRegion" TEXT,
                    ADD COLUMN     "providersSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "tmdbId" INTEGER,
    "mediaType" "MediaType" NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER,
    "reason" "SuppressionReason" NOT NULL DEFAULT 'NOT_INTERESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Suppression_userId_idx" ON "Suppression"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_userId_matchKey_key" ON "Suppression"("userId", "matchKey");

-- CreateIndex
CREATE INDEX "Title_userId_nextEpisodeAirDate_idx" ON "Title"("userId", "nextEpisodeAirDate");

-- CreateIndex
CREATE INDEX "Title_userId_metadataSyncedAt_idx" ON "Title"("userId", "metadataSyncedAt");

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
