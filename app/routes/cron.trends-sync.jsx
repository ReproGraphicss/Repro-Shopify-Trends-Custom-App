/* global Buffer, process */
import { timingSafeEqual } from "node:crypto";
import prisma from "../db.server";
import {
  ensureTrendsMetafieldDefinitions,
  getPrimaryLocation,
  isTrendsQuoteOnlyError,
  syncTrendsProduct,
  syncTrendsPriceAndInventory,
} from "../lib/shopify-sync.server";
import { TrendsClient } from "../lib/trends.server";
import { normalizeTrendsUrl } from "../lib/trends-url";
import { unauthenticated } from "../shopify.server";

const activeRuns = new Map();

const conflictingModesFor = (mode) =>
  mode === "full" ? ["full", "catalog", "prices"] : [mode, "full"];

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

async function getConnectedShopSettings() {
  const offlineSessions = await prisma.session.findMany({
    where: { isOnline: false },
    distinct: ["shop"],
    select: { shop: true },
  });
  const connectedShops = offlineSessions.map(({ shop }) => shop);
  if (!connectedShops.length) return [];
  return prisma.shopSettings.findMany({
    where: {
      shop: { in: connectedShops },
      encryptedTrendsToken: { not: null },
    },
  });
}

async function runSyncedProductRefresh(mode = "prices", { onProgress } = {}) {
  const startedAt = Date.now();
  // Keep price/inventory refreshes parallel but below the level that can
  // repeatedly exhaust Shopify's GraphQL budget on variant-heavy products.
  const defaultConcurrency = 2;
  const maximumConcurrency = 2;
  const configuredConcurrency = Number(
    (mode === "prices"
      ? process.env.CRON_PRICE_SYNC_CONCURRENCY
      : process.env.CRON_SYNC_CONCURRENCY) || defaultConcurrency,
  );
  const concurrency = Math.max(
    1,
    Math.min(
      maximumConcurrency,
      Number.isFinite(configuredConcurrency)
        ? configuredConcurrency
        : defaultConcurrency,
    ),
  );
  const settingsRows = await getConnectedShopSettings();
  const result = {
    shops: 0,
    products: 0,
    updated: 0,
    failed: 0,
    concurrency,
    mode,
    durationMs: 0,
    remaining: 0,
    priceChecked: 0,
    priceChanged: 0,
    priceUnchanged: 0,
    inventoryChecked: 0,
    inventoryChanged: 0,
    inventoryUnchanged: 0,
    errors: [],
    items: [],
  };
  let lastReportedProcessed = 0;
  let progressUpdate = Promise.resolve();
  const reportProgress = (force = false) => {
    if (!onProgress) return progressUpdate;
    const processed = result.updated + result.failed;
    if (!force && processed - lastReportedProcessed < 10) return progressUpdate;
    lastReportedProcessed = processed;
    const snapshot = {
      ...result,
      processed,
      remaining: Math.max(0, result.products - processed),
      durationMs: Date.now() - startedAt,
      items: [...result.items],
      errors: [...result.errors],
    };
    progressUpdate = progressUpdate
      .catch(() => {})
      .then(() => onProgress(snapshot));
    return progressUpdate;
  };

  for (const settings of settingsRows) {
    const token = settings.encryptedTrendsToken || "";
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
      await reportProgress(true);
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
          let previousProduct = {};
          try {
            previousProduct = JSON.parse(row.trendsDataJson || "{}");
          } catch {
            previousProduct = {};
          }
          const pricingChanged =
            JSON.stringify(previousProduct.pricing || []) !==
            JSON.stringify(product.pricing || []);
          const stockChanged =
            JSON.stringify(previousProduct.stock || []) !==
            JSON.stringify(product.stock || []);
          const markupPercent =
            row.individualMarkup ?? settings.globalMarkupPercent;
          const synced =
            mode === "full"
              ? await syncTrendsProduct({
                  admin,
                  shop: settings.shop,
                  product,
                  shopifyProductId: row.shopifyProductId,
                  shopifyMasterProductId: row.shopifyMasterProductId,
                  shopifyAdditionalProductId: row.shopifyAdditionalProductId,
                  markupPercent,
                  fixedShippingAmount: settings.fixedShippingAmount,
                  locationId,
                  extraTags: JSON.parse(row.tagsJson || "[]"),
                  templateSuffix: settings.productTemplateSuffix,
                  selectedPublicationIds: settings.selectedPublicationIdsJson
                    ? JSON.parse(settings.selectedPublicationIdsJson)
                    : null,
                  shippingProfileId: settings.shippingProfileId,
                  customCorporatePackEnabled: row.customCorporatePackEnabled,
                })
              : await syncTrendsPriceAndInventory({
                  admin,
                  shop: settings.shop,
                  product,
                  shopifyProductId: row.shopifyProductId,
                  shopifyMasterProductId: row.shopifyMasterProductId,
                  shopifyAdditionalProductId: row.shopifyAdditionalProductId,
                  markupPercent,
                  fixedShippingAmount: settings.fixedShippingAmount,
                  locationId,
                  extraTags: JSON.parse(row.tagsJson || "[]"),
                  customCorporatePackEnabled: row.customCorporatePackEnabled,
                  refreshConfiguration: pricingChanged || stockChanged,
                  refreshConfiguredPrices: pricingChanged,
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
              shopifyAdditionalProductId: null,
              ...(mode === "full"
                ? {
                    title: product.name,
                    shopifyProductId: synced.id,
                    shopifyMasterProductId: synced.masterProductId,
                  }
                : { shopifyMasterProductId: synced.masterProductId }),
            },
          });
          result.updated++;
          result.items.push({
            code: String(code),
            title: row.title || product.name || "TRENDS product",
            status: "success",
            action:
              mode === "full"
                ? "full_product_refreshed"
                : synced.priceChanged || synced.inventoryChanged
                  ? "price_or_quantity_updated"
                  : "verified_no_change",
            shopifyProductId: synced.id || row.shopifyProductId,
            shopifyMasterProductId:
              synced.masterProductId || row.shopifyMasterProductId,
            changes:
              mode === "full"
                ? [
                    "Product details refreshed",
                    "Variants refreshed",
                    "Pricing configuration refreshed",
                    "Inventory refreshed",
                    "Branding configuration refreshed",
                  ]
                : [
                    ...(pricingChanged
                      ? [
                          "Supplier pricing changed",
                          "Configured product prices refreshed",
                        ]
                      : []),
                    ...(stockChanged ? ["Supplier stock data changed"] : []),
                  ],
            priceChecked: synced.priceChecked || 0,
            priceChanged: synced.priceChanged || 0,
            priceChanges: synced.priceChanges || [],
            inventoryChecked: synced.inventoryChecked || 0,
            inventoryChanged: synced.inventoryChanged || 0,
            inventoryChanges: synced.inventoryChanges || [],
            configurationUpdated: pricingChanged || stockChanged,
            configuredPricesUpdated: pricingChanged,
          });
          if (mode !== "full") {
            result.priceChecked += synced.priceChecked || 0;
            result.priceChanged += synced.priceChanged || 0;
            result.priceUnchanged += synced.priceUnchanged || 0;
            result.inventoryChecked += synced.inventoryChecked || 0;
            result.inventoryChanged += synced.inventoryChanged || 0;
            result.inventoryUnchanged += synced.inventoryUnchanged || 0;
          }
          await reportProgress();
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
          result.items.push({
            code: String(code),
            title: row.title || "TRENDS product",
            status: "failed",
            action: mode === "full" ? "full_refresh_failed" : "sync_failed",
            message,
          });
          if (result.errors.length < 20)
            result.errors.push({ shop: settings.shop, code, message });
          await reportProgress();
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
  result.remaining = result.failed;
  result.durationMs = Date.now() - startedAt;
  await reportProgress(true);
  return result;
}

async function runCatalogBatch(requestedLimit = 25) {
  const startedAt = Date.now();
  const limit = Math.max(1, Math.min(25, Number(requestedLimit) || 25));
  const configuredConcurrency = Number(
    process.env.CRON_CATALOG_CONCURRENCY || 3,
  );
  const concurrency = Math.max(
    1,
    Math.min(
      5,
      Number.isFinite(configuredConcurrency) ? configuredConcurrency : 3,
    ),
  );
  const settingsRows = await getConnectedShopSettings();
  const result = {
    mode: "catalog",
    limit,
    concurrency,
    shops: 0,
    requested: 0,
    synced: 0,
    quoteOnly: 0,
    failed: 0,
    remaining: 0,
    durationMs: 0,
    errors: [],
    items: [],
  };

  for (const settings of settingsRows) {
    if (!settings.encryptedTrendsToken) continue;
    result.shops++;
    try {
      await prisma.syncProduct.updateMany({
        where: {
          shop: settings.shop,
          status: "SYNCED",
          trendsDataJson: { not: null },
          OR: [{ shopifyProductId: null }, { shopifyMasterProductId: null }],
        },
        data: {
          status: "FETCHED",
          lastError:
            "Main/master Shopify relationship was incomplete and queued for repair.",
        },
      });
      await prisma.syncProduct.updateMany({
        where: {
          shop: settings.shop,
          status: "SYNCING",
          updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) },
        },
        data: {
          status: "FETCHED",
          lastError: "Previous automatic sync was interrupted and retried.",
        },
      });

      // Drain newly fetched products first. Failed products are retried only
      // after that queue is empty, so retries cannot hold up first-time syncs.
      const fetchedRows = await prisma.syncProduct.findMany({
        where: {
          shop: settings.shop,
          sourceFile: { not: null },
          trendsDataJson: { not: null },
          status: "FETCHED",
        },
        orderBy: [{ rowNumber: "asc" }, { createdAt: "asc" }],
        take: limit,
      });
      const failedRows =
        fetchedRows.length === 0
          ? await prisma.syncProduct.findMany({
              where: {
                shop: settings.shop,
                sourceFile: { not: null },
                trendsDataJson: { not: null },
                status: "FAILED",
              },
              orderBy: [{ updatedAt: "asc" }, { rowNumber: "asc" }],
              take: limit,
            })
          : [];
      const rows = [...fetchedRows, ...failedRows];
      result.requested += rows.length;
      if (!rows.length) continue;

      const { admin } = await unauthenticated.admin(settings.shop);
      const locationId = await getPrimaryLocation(
        admin,
        settings.inventoryLocationId,
      );
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

      await mapWithConcurrency(rows, concurrency, async (row) => {
        await prisma.syncProduct.update({
          where: { id: row.id },
          data: { status: "SYNCING", lastError: null },
        });
        try {
          const product = JSON.parse(row.trendsDataJson);
          const synced = await syncTrendsProduct({
            admin,
            shop: settings.shop,
            product,
            shopifyProductId: row.shopifyProductId,
            shopifyMasterProductId: row.shopifyMasterProductId,
            shopifyAdditionalProductId: row.shopifyAdditionalProductId,
            markupPercent: row.individualMarkup ?? settings.globalMarkupPercent,
            fixedShippingAmount: settings.fixedShippingAmount,
            locationId,
            extraTags: JSON.parse(row.tagsJson || "[]"),
            templateSuffix: settings.productTemplateSuffix,
            selectedPublicationIds: settings.selectedPublicationIdsJson
              ? JSON.parse(settings.selectedPublicationIdsJson)
              : null,
            shippingProfileId: settings.shippingProfileId,
            customCorporatePackEnabled: row.customCorporatePackEnabled,
          });
          await prisma.syncProduct.update({
            where: { id: row.id },
            data: {
              title: product.name,
              resolvedProductCode: String(product.code),
              imageUrl: normalizeTrendsUrl(product.images?.[0]?.link),
              status: "SYNCED",
              shopifyProductId: synced.id,
              shopifyMasterProductId: synced.masterProductId,
              shopifyAdditionalProductId:
                synced.additionalProducts?.[0]?.id || null,
              lastSyncedAt: new Date(),
              lastError: null,
            },
          });
          result.synced++;
          result.items.push({
            code: String(product.code),
            title: product.name || row.title || "TRENDS product",
            status: "success",
            action: row.shopifyProductId
              ? "product_updated"
              : "product_created",
            shopifyProductId: synced.id,
            shopifyMasterProductId: synced.masterProductId,
            changes: row.shopifyProductId
              ? [
                  "Product details updated",
                  "Variants updated",
                  "Pricing and inventory updated",
                  "Product configuration updated",
                ]
              : [
                  "Shopify product created",
                  "Product variants created",
                  "Configured master product created",
                  "Pricing and inventory applied",
                ],
          });
        } catch (error) {
          const message = (
            error instanceof Error ? error.message : "Catalog sync failed"
          ).slice(0, 1000);
          const isQuoteOnly = isTrendsQuoteOnlyError(error);
          await prisma.syncProduct.update({
            where: { id: row.id },
            data: {
              status: isQuoteOnly ? "QUOTE_ONLY" : "FAILED",
              lastError: message,
            },
          });
          if (isQuoteOnly) result.quoteOnly++;
          else result.failed++;
          result.items.push({
            code: String(row.resolvedProductCode || row.productCode),
            title: row.title || "TRENDS product",
            status: isQuoteOnly ? "quote_only" : "failed",
            action: isQuoteOnly ? "quote_only_skipped" : "product_sync_failed",
            message,
          });
          if (!isQuoteOnly && result.errors.length < 20)
            result.errors.push({
              shop: settings.shop,
              code: row.resolvedProductCode || row.productCode,
              message,
            });
        }
      });
    } catch (error) {
      result.failed++;
      result.errors.push({
        shop: settings.shop,
        message: error instanceof Error ? error.message : "Shop sync failed",
      });
    }
    result.remaining += await prisma.syncProduct.count({
      where: {
        shop: settings.shop,
        sourceFile: { not: null },
        trendsDataJson: { not: null },
        status: { in: ["FETCHED", "FAILED"] },
      },
    });
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
  const url = new URL(request.url);
  const requestedMode = url.searchParams.get("mode");
  const mode = ["full", "catalog"].includes(requestedMode)
    ? requestedMode
    : "prices";
  const conflictingModes = conflictingModesFor(mode);
  const activeMode = conflictingModes.find((candidate) =>
    activeRuns.has(candidate),
  );
  if (activeMode)
    return Response.json(
      {
        ok: true,
        accepted: false,
        skipped: true,
        message: "A TRENDS synchronization is already running",
        activeMode,
      },
      { status: 200 },
    );

  const connectedSettings = await getConnectedShopSettings();
  const logShops = connectedSettings.map(({ shop }) => ({ shop }));
  const shopNames = logShops.map(({ shop }) => shop);
  const staleAfterMinutes =
    mode === "prices" ? 18 : mode === "catalog" ? 45 : 180;
  const staleBefore = new Date(Date.now() - staleAfterMinutes * 60 * 1000);
  await prisma.cronSyncLog.updateMany({
    where: {
      shop: { in: shopNames },
      status: "RUNNING",
      mode: { in: conflictingModes },
      startedAt: { lt: staleBefore },
    },
    data: {
      status: "INTERRUPTED",
      errorsJson: JSON.stringify([
        { message: "The previous run did not report completion." },
      ]),
      finishedAt: new Date(),
    },
  });
  const databaseRuns = await prisma.cronSyncLog.findMany({
    where: {
      shop: { in: shopNames },
      status: "RUNNING",
      mode: { in: conflictingModes },
      startedAt: { gte: staleBefore },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, mode: true, startedAt: true },
  });
  const databaseRun = databaseRuns[0];
  if (databaseRuns.length > 1) {
    await prisma.cronSyncLog.updateMany({
      where: { id: { in: databaseRuns.slice(1).map(({ id }) => id) } },
      data: {
        status: "INTERRUPTED",
        errorsJson: JSON.stringify([
          { message: "Run was superseded by another overlapping cron run." },
        ]),
        finishedAt: new Date(),
      },
    });
  }
  if (databaseRun)
    return Response.json(
      {
        ok: true,
        accepted: false,
        skipped: true,
        message: "A TRENDS synchronization is already running",
        activeMode: databaseRun.mode,
        activeSince: databaseRun.startedAt.toISOString(),
      },
      { status: 200 },
    );
  const logRows = await Promise.all(
    logShops.map(({ shop }) =>
      prisma.cronSyncLog.create({
        data: { shop, mode, status: "RUNNING" },
        select: { id: true },
      }),
    ),
  );

  const updateRunningLog = async (progress) => {
    await prisma.cronSyncLog.updateMany({
      where: { id: { in: logRows.map(({ id }) => id) }, status: "RUNNING" },
      data: {
        products: progress.products,
        processed: progress.processed,
        updated: progress.updated,
        failed: progress.failed,
        remaining: progress.remaining,
        priceChecked: progress.priceChecked,
        priceChanged: progress.priceChanged,
        priceUnchanged: progress.priceUnchanged,
        inventoryChecked: progress.inventoryChecked,
        inventoryChanged: progress.inventoryChanged,
        inventoryUnchanged: progress.inventoryUnchanged,
        durationMs: progress.durationMs,
        errorsJson: JSON.stringify(progress.errors || []),
        detailsJson: JSON.stringify(progress.items || []),
      },
    });
  };
  const run =
    mode === "catalog"
      ? runCatalogBatch(url.searchParams.get("limit"))
      : runSyncedProductRefresh(mode, { onProgress: updateRunningLog });
  activeRuns.set(mode, run);
  void run
    .then(async (result) => {
      const processed =
        mode === "catalog"
          ? result.synced + result.quoteOnly + result.failed
          : result.updated + result.failed;
      const updated = mode === "catalog" ? result.synced : result.updated;
      const products = mode === "catalog" ? result.requested : result.products;
      const status =
        result.failed === 0 ? "COMPLETED" : updated > 0 ? "PARTIAL" : "FAILED";
      await Promise.all(
        logRows.map(({ id }) =>
          prisma.cronSyncLog.update({
            where: { id },
            data: {
              status,
              products,
              processed,
              updated,
              failed: result.failed,
              remaining: result.remaining ?? result.failed,
              priceChecked: result.priceChecked || 0,
              priceChanged: result.priceChanged || 0,
              priceUnchanged: result.priceUnchanged || 0,
              inventoryChecked: result.inventoryChecked || 0,
              inventoryChanged: result.inventoryChanged || 0,
              inventoryUnchanged: result.inventoryUnchanged || 0,
              durationMs: result.durationMs,
              errorsJson: JSON.stringify(result.errors || []),
              detailsJson: JSON.stringify(result.items || []),
              finishedAt: new Date(),
            },
          }),
        ),
      );
      console.info(`Automatic TRENDS ${mode} sync completed`, result);
    })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : "Cron failed";
      await Promise.all(
        logRows.map(({ id }) =>
          prisma.cronSyncLog.update({
            where: { id },
            data: {
              status: "FAILED",
              failed: 1,
              remaining: 1,
              errorsJson: JSON.stringify([{ message }]),
              finishedAt: new Date(),
            },
          }),
        ),
      );
      console.error(`Automatic TRENDS ${mode} sync failed`, error);
    })
    .finally(() => {
      if (activeRuns.get(mode) === run) activeRuns.delete(mode);
    });
  return Response.json(
    {
      ok: true,
      accepted: true,
      mode,
      ...(mode === "catalog"
        ? {
            limit: Math.max(
              1,
              Math.min(25, Number(url.searchParams.get("limit")) || 25),
            ),
          }
        : {}),
      message: `${mode === "catalog" ? "Catalog" : mode === "full" ? "Full product" : "Price and inventory"} synchronization started in the background`,
    },
    { status: 202 },
  );
};

export const loader = ({ request }) => handleCron(request);
export const action = ({ request }) => handleCron(request);
