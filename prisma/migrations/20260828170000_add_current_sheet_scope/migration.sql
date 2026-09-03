ALTER TABLE "SyncProduct" ADD COLUMN "includedInCurrentSheet" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "SyncProduct_shop_includedInCurrentSheet_idx"
ON "SyncProduct"("shop", "includedInCurrentSheet");
