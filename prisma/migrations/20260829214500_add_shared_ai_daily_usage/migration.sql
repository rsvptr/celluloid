-- CreateTable
CREATE TABLE "SharedAiDailyUsage" (
    "day" DATE NOT NULL,
    "runCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SharedAiDailyUsage_pkey" PRIMARY KEY ("day")
);
