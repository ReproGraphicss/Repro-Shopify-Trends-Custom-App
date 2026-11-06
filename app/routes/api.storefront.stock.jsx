import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });

const readInput = async (request) => {
  const url = new URL(request.url);
  if (request.method === "GET")
    return {
      sku:
        url.searchParams.get("sku") ||
        url.searchParams.get("mainSku") ||
        url.searchParams.get("productSku"),
    };

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return request.json();
  const form = await request.formData();
  return Object.fromEntries(form);
};

const findMainProduct = async (shop, sku) => {
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
      resolvedProductCode: true,
      trendsDataJson: true,
      trendsFetchedAt: true,
      lastSyncedAt: true,
    },
    orderBy: { lastSyncedAt: "desc" },
  });

  for (const row of rows) {
    try {
      const product = JSON.parse(row.trendsDataJson);
      // The endpoint intentionally accepts only the parent/main product SKU,
      // never a colour/stock variant SKU.
      if (String(product.code || "").trim() === sku) return { row, product };
    } catch {
      // Ignore an unreadable legacy record and continue looking for a valid one.
    }
  }
  return null;
};

const handle = async (request) => {
  if (request.method === "OPTIONS") return json({ ok: true });
  if (!["GET", "POST"].includes(request.method))
    return json(
      { ok: false, message: "Use GET or POST for this endpoint" },
      405,
    );

  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop)
    return json({ ok: false, message: "Store is not connected" }, 401);

  try {
    const input = await readInput(request);
    const sku = String(
      input.sku || input.mainSku || input.productSku || "",
    ).trim();
    if (!sku)
      return json({ ok: false, message: "Main product SKU is required" }, 400);

    const match = await findMainProduct(session.shop, sku);
    if (!match)
      return json(
        {
          ok: false,
          message: "No synced TRENDS product was found for this main SKU",
        },
        404,
      );

    const stock = (
      Array.isArray(match.product.stock) ? match.product.stock : []
    ).map((item) => ({
      sku: String(item.stock_code || ""),
      colour: String(item.description || item.colour || item.color || ""),
      quantity: Number.isFinite(Number(item.quantity))
        ? Number(item.quantity)
        : 0,
      nextShipment: Number.isFinite(Number(item.next_shipment))
        ? Number(item.next_shipment)
        : 0,
      dueDate: item.due_date ? String(item.due_date) : null,
    }));

    return json({
      ok: true,
      mainSku: String(match.product.code),
      productName: match.product.name || match.row.title || null,
      stockUpdatedAt:
        match.row.trendsFetchedAt || match.row.lastSyncedAt || null,
      variantCount: stock.length,
      totalStock: stock.reduce((total, item) => total + item.quantity, 0),
      stock,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Stock lookup failed",
      },
      500,
    );
  }
};

export const loader = ({ request }) => handle(request);
export const action = ({ request }) => handle(request);
