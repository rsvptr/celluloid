-- AlterTable
ALTER TABLE "user" ADD COLUMN     "recommendModel" TEXT;

-- CreateTable
CREATE TABLE "ShareList" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT,
    "titleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "includeNotes" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareList_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShareList_slug_key" ON "ShareList"("slug");

-- CreateIndex
CREATE INDEX "ShareList_userId_idx" ON "ShareList"("userId");

-- AddForeignKey
ALTER TABLE "ShareList" ADD CONSTRAINT "ShareList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
