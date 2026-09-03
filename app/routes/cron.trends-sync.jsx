import { timingSafeEqual } from "node:crypto";
import prisma from "../db.server";
import { decryptSecret } from "../lib/crypto.server";
import {
  ensureTrendsMetafieldDefinitions,
  getPrimaryLocation,
  syncTrendsProduct,
  syncTrendsPriceAndInventory,
} from "../lib/shopify-sync.server";
import { TrendsClient } from "../lib/trends.server";
import { unauthenticated } from "../shopify.server";

let activeRun = null;

const authorized = (request) => {
  const expected = process.env.CRON_SECRET || "";
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    request.headers.get("x-cron-secret") ||
    "";
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
};

const mapWithConcurrency = async (items, concurrency, worker) => {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length) await worker(queue.shift());
    },
  );
  await Promise.all(workers);
};

async function runSyncedProductRefresh(mode = "prices") {
  const startedAt = Date.now();
  const configuredConcurrency = Number(process.env.CRON_SYNC_CONCURRENCY || 12);
  const concurrency = Math.max(
    1,
    Math.min(
      20,
      Number.isFinite(configuredConcurrency) ? configuredConcurrency : 12,
    ),
  );
  const settingsRows = await prisma.shopSettings.findMany();
  const result = {
    shops: 0,
    products: 0,
    updated: 0,
    failed: 0,
    concurrency,
    mode,
    durationMs: 0,
    errors: [],
  };

  for (const settings of settingsRows) {
    const token =
      process.env.TRENDS_API_TOKEN ||
      (settings.encryptedTrendsToken
        ? decryptSecret(settings.encryptedTrendsToken)
        : "");
    if (!token) continue;

    result.shops++;
    try {
      const { admin } = await unauthenticated.admin(settings.shop);
      const locationId = await getPrimaryLocation(
        admin,
        settings.inventoryLocationId,
      );
      const rows = await prisma.syncProduct.findMany({
        where: {
          shop: settings.shop,
          status: "SYNCED",
          shopifyProductId: { not: null },
        },
        orderBy: { updatedAt: "desc" },
      });
      const products = [
        ...new Map(
          rows.map((row) => [row.resolvedProductCode || row.productCode, row]),
        ).values(),
      ];
      result.products += products.length;
      const client = new TrendsClient(settings.trendsBaseUrl, token);

      if (mode === "full") {
        try {
          await ensureTrendsMetafieldDefinitions(admin);
        } catch (error) {
          result.errors.push({
            shop: settings.shop,
            message: `Metafield definition setup skipped: ${
              error instanceof Error ? error.message : "Shopify API error"
            }`,
          });
        }
      }

      await mapWithConcurrency(products, concurrency, async (row) => {
        const code = row.resolvedProductCode || row.productCode;
        try {
          const product = await client.getProduct(String(code));
          const markupPercent =
            row.individualMarkup ?? settings.globalMarkupPercent;
          const additionalMarkupPercent =
            row.additionalMarkup ?? settings.additionalMarkupPercent;
          const synced =
            mode === "full"
              ? await syncTrendsProduct({
                  admin,
                  product,
                  shopifyProductId: row.shopifyProductId,
                  shopifyAdditionalProductId: row.shopifyAdditionalProductId,
                  markupPercent,
                  additionalMarkupPercent,
                  locationId,
                  extraTags: JSON.parse(row.tagsJson || "[]"),
                })
              : await syncTrendsPriceAndInventory({
                  admin,
                  product,
                  shopifyProductId: row.shopifyProductId,
                  shopifyAdditionalProductId: row.shopifyAdditionalProductId,
                  markupPercent,
                  additionalMarkupPercent,
                  locationId,
                });
          await prisma.syncProduct.updateMany({
            where: {
              shop: settings.shop,
              OR: [
                { resolvedProductCode: String(product.code) },
                { productCode: String(product.code) },
              ],
            },
            data: {
              trendsDataJson: JSON.stringify(product),
              trendsFetchedAt: new Date(),
              lastSyncedAt: new Date(),
              lastError: null,
              ...(mode === "full"
                ? {
                    title: product.name,
                    shopifyProductId: synced.id,
                    shopifyAdditionalProductId:
                      synced.additionalProducts?.[0]?.id || null,
                  }
                : {}),
            },
          });
          result.updated++;
        } catch (error) {
          const message = (
            error instanceof Error ? error.message : "Unknown cron error"
          ).slice(0, 1000);
          await prisma.syncProduct.updateMany({
            where: { shop: settings.shop, id: row.id },
            data: {
              lastError: `Automatic ${mode === "full" ? "full product" : "price/inventory"} sync: ${message}`,
            },
          });
          result.failed++;
          if (result.errors.length < 20)
            result.errors.push({ shop: settings.shop, code, message });
        }
      });
    } catch (error) {
      result.failed++;
      result.errors.push({
        shop: settings.shop,
        message: error instanceof Error ? error.message : "Shop sync failed",
      });
    }
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

const handleCron = async (request) => {
  if (!authorized(request))
    return Response.json(
      { ok: false, message: "Unauthorized" },
      { status: 401 },
    );
  const requestedMode = new URL(request.url).searchParams.get("mode");
  const mode = requestedMode === "full" ? "full" : "prices";
  if (activeRun)
    return Response.json(
      { ok: false, message: "A price and inventory sync is already running" },
      { status: 409 },
    );

  activeRun = runSyncedProductRefresh(mode);
  try {
    const result = await activeRun;
    return Response.json({ ok: result.failed === 0, ...result });
  } finally {
    activeRun = null;
  }
};

export const loader = ({ request }) => handleCron(request);
export const action = ({ request }) => handleCron(request);
