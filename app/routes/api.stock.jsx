/* global process */
import prisma from "../db.server";

const allowedOrigins = new Set([
  "https://reprographics.co.nz",
  "https://www.reprographics.co.nz",
]);

const corsHeaders = (request) => {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://www.reprographics.co.nz",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
    "Cache-Control": "no-store, max-age=0",
  };
};

const json = (request, body, status = 200) =>
  Response.json(body, { status, headers: corsHeaders(request) });

const connectedShop = async () => {
  const configuredShop = String(process.env.STOREFRONT_SHOP || "").trim();
  if (configuredShop) return configuredShop;
  const session = await prisma.session.findFirst({
    where: { isOnline: false },
    select: { shop: true },
  });
  return session?.shop || null;
};

const stockForMainSku = async (shop, sku) => {
  const rows = await prisma.syncProduct.findMany({
    where: {
      shop,
      status: "SYNCED",
      shopifyProductId: { not: null },
      trendsDataJson: { not: null },
      OR: [{ resolvedProductCode: sku }, { productCode: sku }],
    },
    select: {
      title: true,
      trendsDataJson: true,
      trendsFetchedAt: true,
      lastSyncedAt: true,
    },
    orderBy: { lastSyncedAt: "desc" },
  });

  for (const row of rows) {
    try {
      const product = JSON.parse(row.trendsDataJson);
      if (String(product.code || "").trim() !== sku) continue;
      const stock = (Array.isArray(product.stock) ? product.stock : []).map(
        (item) => ({
          sku: String(item.stock_code || ""),
          colour: String(item.description || item.colour || item.color || ""),
          quantity: Number.isFinite(Number(item.quantity))
            ? Number(item.quantity)
            : 0,
          nextShipment: Number.isFinite(Number(item.next_shipment))
            ? Number(item.next_shipment)
            : 0,
          dueDate: item.due_date ? String(item.due_date) : null,
        }),
      );
      return {
        ok: true,
        mainSku: String(product.code),
        productName: product.name || row.title || null,
        stockUpdatedAt: row.trendsFetchedAt || row.lastSyncedAt || null,
        variantCount: stock.length,
        totalStock: stock.reduce((total, item) => total + item.quantity, 0),
        stock,
      };
    } catch {
      // Continue to another synced copy when a legacy JSON value is unreadable.
    }
  }
  return null;
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders(request) });

  const sku = String(new URL(request.url).searchParams.get("sku") || "").trim();
  if (!sku)
    return json(
      request,
      { ok: false, message: "Main product SKU is required" },
      400,
    );

  const shop = await connectedShop();
  if (!shop)
    return json(request, { ok: false, message: "Store is not connected" }, 503);

  const result = await stockForMainSku(shop, sku);
  if (!result)
    return json(
      request,
      {
        ok: false,
        message: "No synced TRENDS product was found for this main SKU",
      },
      404,
    );
  return json(request, result);
};
