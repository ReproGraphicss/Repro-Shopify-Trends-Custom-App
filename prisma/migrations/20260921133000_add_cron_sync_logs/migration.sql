CREATE TABLE "CronSyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "products" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "priceChecked" INTEGER NOT NULL DEFAULT 0,
    "priceChanged" INTEGER NOT NULL DEFAULT 0,
    "priceUnchanged" INTEGER NOT NULL DEFAULT 0,
    "inventoryChecked" INTEGER NOT NULL DEFAULT 0,
    "inventoryChanged" INTEGER NOT NULL DEFAULT 0,
    "inventoryUnchanged" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "errorsJson" TEXT NOT NULL DEFAULT '[]',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

CREATE INDEX "CronSyncLog_shop_startedAt_idx" ON "CronSyncLog"("shop", "startedAt");
CREATE INDEX "CronSyncLog_shop_mode_idx" ON "CronSyncLog"("shop", "mode");
