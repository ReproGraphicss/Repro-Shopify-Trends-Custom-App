ALTER TABLE "SyncProduct" ADD COLUMN "resolvedProductCode" TEXT;
ALTER TABLE "SyncProduct" ADD COLUMN "sourceFile" TEXT;
ALTER TABLE "SyncProduct" ADD COLUMN "rowNumber" INTEGER;
ALTER TABLE "SyncProduct" ADD COLUMN "metadataJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "SyncProduct" ADD COLUMN "tagsJson" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE "TrendsCatalogProduct" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "productCode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "imageUrl" TEXT,
  "categories" TEXT NOT NULL DEFAULT '[]',
  "colours" TEXT,
  "active" TEXT,
  "status" TEXT,
  "variantCount" INTEGER NOT NULL DEFAULT 0,
  "totalStock" INTEGER NOT NULL DEFAULT 0,
  "rawJson" TEXT NOT NULL,
  "supplierUpdatedAt" TEXT,
  "refreshedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "TrendsCatalogProduct_shop_productCode_key" ON "TrendsCatalogProduct"("shop", "productCode");
CREATE INDEX "TrendsCatalogProduct_shop_name_idx" ON "TrendsCatalogProduct"("shop", "name");
CREATE INDEX "TrendsCatalogProduct_shop_status_idx" ON "TrendsCatalogProduct"("shop", "status");
