import prisma from "../db.server";
import { calculateTrendsTierPrice } from "../lib/shopify-sync.server";
import { authenticate } from "../shopify.server";

const response = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

const readInput = async (request) => {
  const url = new URL(request.url);
  if (request.method === "GET")
    return {
      variantSku:
        url.searchParams.get("variantSku") || url.searchParams.get("sku"),
      quantity: url.searchParams.get("quantity") || url.searchParams.get("qty"),
      brandingSku: url.searchParams.get("brandingSku"),
      brandingQuantity: url.searchParams.get("brandingQuantity"),
      packagingSku:
        url.searchParams.get("packagingSku") ||
        url.searchParams.get("giftBoxSku"),
      packagingQuantity: url.searchParams.get("packagingQuantity"),
      shippingService:
        url.searchParams.get("shippingService") ||
        url.searchParams.get("freightService"),
    };
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return request.json();
  const form = await request.formData();
  return Object.fromEntries(form);
};

const findSyncedProduct = async (shop, variantSku) => {
  const rows = await prisma.syncProduct.findMany({
    where: {
      shop,
      status: "SYNCED",
      shopifyProductId: { not: null },
      trendsDataJson: { not: null },
    },
    select: {
      productCode: true,
      resolvedProductCode: true,
      trendsDataJson: true,
      individualMarkup: true,
    },
    orderBy: { lastSyncedAt: "desc" },
  });
  for (const row of rows) {
    let product;
    try {
      product = JSON.parse(row.trendsDataJson);
    } catch {
      continue;
    }
    const matches =
      String(product.code) === variantSku ||
      (product.stock || []).some(
        (stock) => String(stock.stock_code) === variantSku,
      );
    if (matches) return { row, product };
  }
  return null;
};

const handle = async (request) => {
  if (request.method === "OPTIONS") return response({ ok: true });
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop)
    return response({ ok: false, message: "Store is not connected" }, 401);
  try {
    const input = await readInput(request);
    const variantSku = String(input.variantSku || "").trim();
    const quantity = Math.trunc(
      Number(input.productQuantity ?? input.quantity),
    );
    const brandingSku = String(input.brandingSku || "").trim() || null;
    const packagingSku =
      String(input.packagingSku || input.giftBoxSku || "").trim() || null;
    if (!variantSku)
      return response({ ok: false, message: "variantSku is required" }, 400);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100000)
      return response(
        { ok: false, message: "quantity must be between 1 and 100000" },
        400,
      );
    const selectedQuantity = (value, label) => {
      const result = Math.trunc(Number(value ?? quantity));
      if (!Number.isFinite(result) || result < 1 || result > 100000)
        throw new Error(`${label} must be between 1 and 100000`);
      return result;
    };

    const match = await findSyncedProduct(session.shop, variantSku);
    if (!match)
      return response(
        { ok: false, message: "This SKU is not a synced TRENDS product" },
        404,
      );
    const settings = await prisma.shopSettings.findUnique({
      where: { shop: session.shop },
    });
    const result = calculateTrendsTierPrice({
      product: match.product,
      quantity,
      markupPercent:
        match.row.individualMarkup ?? settings?.globalMarkupPercent ?? 0,
      fixedShippingAmount: settings?.fixedShippingAmount ?? 15,
      additionalSelections: [
        brandingSku
          ? {
              sku: brandingSku,
              quantity: selectedQuantity(
                input.brandingQuantity,
                "brandingQuantity",
              ),
            }
          : null,
        packagingSku
          ? {
              sku: packagingSku,
              quantity: selectedQuantity(
                input.packagingQuantity,
                "packagingQuantity",
              ),
            }
          : null,
      ].filter(Boolean),
      shippingService: input.shippingService || input.freightService,
    });
    return response({
      ok: true,
      currency: "NZD",
      productCode: String(match.product.code),
      variantSku,
      ...result,
    });
  } catch (error) {
    return response(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Pricing failed",
      },
      500,
    );
  }
};

export const loader = ({ request }) => handle(request);
export const action = ({ request }) => handle(request);
