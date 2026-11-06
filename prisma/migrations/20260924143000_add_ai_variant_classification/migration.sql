ALTER TABLE "ShopSettings" ADD COLUMN "encryptedOpenAiApiKey" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "aiVariantClassificationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings" ADD COLUMN "aiVariantModel" TEXT NOT NULL DEFAULT 'gpt-5-mini';
