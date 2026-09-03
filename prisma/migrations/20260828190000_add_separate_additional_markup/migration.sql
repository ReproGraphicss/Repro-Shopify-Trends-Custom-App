ALTER TABLE "ShopSettings" ADD COLUMN "additionalMarkupPercent" REAL NOT NULL DEFAULT 60;
ALTER TABLE "SyncProduct" ADD COLUMN "additionalMarkup" REAL;
ALTER TABLE "SyncProduct" ADD COLUMN "shopifyAdditionalProductId" TEXT;
