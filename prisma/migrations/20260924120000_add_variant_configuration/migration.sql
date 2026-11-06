ALTER TABLE "ShopSettings" ADD COLUMN "variantTypesJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "SyncProduct" ADD COLUMN "configuredVariantJson" TEXT;
ALTER TABLE "SyncProduct" ADD COLUMN "configuredVariantEnabled" BOOLEAN NOT NULL DEFAULT false;
