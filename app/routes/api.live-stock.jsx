/* global process */
import prisma from "../db.server";
import {
  getPrimaryLocation,
  syncTrendsPriceAndInventory,
} from "../lib/shopify-sync.server";
import { TrendsClient } from "../lib/trends.server";
import { unauthenticated } from "../shopify.server";

const allowedOrigins = new Set([
  "https://reprographics.co.nz",
  "https://www.reprographics.co.nz",
]);
const clients = new Map();
const activeProductSyncs = new Map();

const headersFor = (request) => {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://www.reprographics.co.nz",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store, max-age=0",
    Vary: "Origin",
  };
};

const json = (request, body, status = 200) =>
  Response.json(body, { status, headers: headersFor(request) });

const connectedSettings = async () => {
  const configuredShop = String(process.env.STOREFRONT_SHOP || "").trim();
  const shop =
    configuredShop ||
    (
      await prisma.session.findFirst({
        where: { isOnline: false },
        select: { shop: true },
      })
    )?.shop;
  if (!shop) return null;
  return prisma.shopSettings.findUnique({ where: { shop } });
};

const clientFor = (settings) => {
  const token = String(settings.encryptedTrendsToken || "").trim();
  const baseUrl = String(settings.trendsBaseUrl || "").replace(/\/$/, "");
  const current = clients.get(settings.shop);
  if (current?.token === token && current?.baseUrl === baseUrl)
    return current.client;
  const client = new TrendsClient(baseUrl, token);
  clients.set(settings.shop, { token, baseUrl, client });
  return client;
};

const updateLinkedShopifyProduct = async ({ settings, product }) => {
  const productCode = String(product.code);
  const row = await prisma.syncProduct.findFirst({
    where: {
      shop: settings.shop,
      status: "SYNCED",
      shopifyProductId: { not: null },
      OR: [{ resolvedProductCode: productCode }, { productCode }],
    },
    orderBy: { lastSyncedAt: "desc" },
  });
  if (!row)
    return {
      status: "not_linked",
      message: "No linked Shopify product was found for this main SKU",
    };

  const lockKey = `${settings.shop}:${productCode}`;
  const running = activeProductSyncs.get(lockKey);
  if (running) return running;

  const synchronization = (async () => {
    const { admin } = await unauthenticated.admin(settings.shop);
    const locationId = await getPrimaryLocation(
      admin,
      settings.inventoryLocationId,
    );
    const result = await syncTrendsPriceAndInventory({
      admin,
      shop: settings.shop,
      product,
      shopifyProductId: row.shopifyProductId,
      shopifyMasterProductId: row.shopifyMasterProductId,
      shopifyAdditionalProductId: row.shopifyAdditionalProductId,
      markupPercent: row.individualMarkup ?? settings.globalMarkupPercent,
      fixedShippingAmount: settings.fixedShippingAmount,
      locationId,
      customCorporatePackEnabled: row.customCorporatePackEnabled,
      refreshConfiguration: true,
      refreshConfiguredPrices: false,
    });
    const syncedAt = new Date();
    await prisma.syncProduct.updateMany({
      where: {
        shop: settings.shop,
        OR: [{ resolvedProductCode: productCode }, { productCode }],
      },
      data: {
        trendsDataJson: JSON.stringify(product),
        trendsFetchedAt: syncedAt,
        lastSyncedAt: syncedAt,
        lastError: null,
        shopifyMasterProductId: result.masterProductId,
        shopifyAdditionalProductId: null,
      },
    });
    return {
      status: "updated",
      syncedAt: syncedAt.toISOString(),
      priceChecked: result.priceChecked,
      priceChanged: result.priceChanged,
      inventoryChecked: result.inventoryChecked,
      inventoryChanged: result.inventoryChanged,
    };
  })();
  activeProductSyncs.set(lockKey, synchronization);
  try {
    return await synchronization;
  } finally {
    if (activeProductSyncs.get(lockKey) === synchronization)
      activeProductSyncs.delete(lockKey);
  }
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: headersFor(request) });

  const sku = String(new URL(request.url).searchParams.get("sku") || "").trim();
  if (!/^\d{1,32}$/.test(sku))
    return json(
      request,
      { ok: false, message: "A valid numeric main product SKU is required" },
      400,
    );

  const settings = await connectedSettings();
  if (!settings?.encryptedTrendsToken)
    return json(
      request,
      { ok: false, message: "TRENDS connection is not configured" },
      503,
    );

  try {
    const product = await clientFor(settings).getProduct(sku);
    if (!product || String(product.code) !== sku)
      return json(
        request,
        {
          ok: false,
          message: "The supplied SKU is not a TRENDS main product SKU",
        },
        404,
      );

    const stock = Array.isArray(product.stock) ? product.stock : [];
    const shopifySync = await updateLinkedShopifyProduct({
      settings,
      product,
    });
    return json(request, {
      ok: true,
      source: "TRENDS live API",
      fetchedAt: new Date().toISOString(),
      mainSku: String(product.code),
      productName: product.name || null,
      variantCount: stock.length,
      totalStock: stock.reduce(
        (total, item) => total + Math.max(0, Number(item.quantity) || 0),
        0,
      ),
      nextShipmentTotal: stock.reduce(
        (total, item) => total + Math.max(0, Number(item.next_shipment) || 0),
        0,
      ),
      stock,
      shopifySync,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Stock lookup failed";
    const notFound = /not found|was not found/i.test(message);
    return json(request, { ok: false, message }, notFound ? 404 : 502);
  }
};
