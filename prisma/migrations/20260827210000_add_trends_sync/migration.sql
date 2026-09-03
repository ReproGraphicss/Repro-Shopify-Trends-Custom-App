CREATE TABLE "ShopSettings" ("id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "encryptedTrendsToken" TEXT, "trendsBaseUrl" TEXT NOT NULL DEFAULT 'https://nz.api.trends.nz', "globalMarkupPercent" REAL NOT NULL DEFAULT 60, "defaultProductStatus" TEXT NOT NULL DEFAULT 'DRAFT', "inventoryLocationId" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL);
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
CREATE TABLE "SyncProduct" ("id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "productCode" TEXT NOT NULL, "title" TEXT, "imageUrl" TEXT, "individualMarkup" REAL, "status" TEXT NOT NULL DEFAULT 'PENDING', "lastError" TEXT, "shopifyProductId" TEXT, "lastSyncedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL);
CREATE UNIQUE INDEX "SyncProduct_shop_productCode_key" ON "SyncProduct"("shop", "productCode");
CREATE INDEX "SyncProduct_shop_status_idx" ON "SyncProduct"("shop", "status");
CREATE TABLE "SyncRun" ("id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "requested" INTEGER NOT NULL, "succeeded" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'RUNNING', "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" DATETIME);
CREATE INDEX "SyncRun_shop_startedAt_idx" ON "SyncRun"("shop", "startedAt");
