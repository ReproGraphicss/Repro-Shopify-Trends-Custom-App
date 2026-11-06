import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { TrendsClient } from "../lib/trends.server";
import { normalizeTrendsUrl } from "../lib/trends-url";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("productId") || "");
  const [item, settings] = await Promise.all([
    prisma.syncProduct.findFirst({
      where: {
        id,
        shop: session.shop,
        sourceFile: { not: null },
      },
    }),
    prisma.shopSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop },
      update: {},
    }),
  ]);
  if (!item)
    return Response.json(
      { ok: false, message: "Sheet item not found" },
      { status: 404 },
    );
  const token = settings.encryptedTrendsToken || "";
  if (!token)
    return Response.json(
      { ok: false, message: "Configure the TRENDS API token in Settings" },
      { status: 400 },
    );
  await prisma.syncProduct.update({
    where: { id },
    data: { status: "FETCHING", lastError: null },
  });
  try {
    const product = await new TrendsClient(
      settings.trendsBaseUrl,
      token,
    ).getProduct(item.productCode);
    await prisma.syncProduct.update({
      where: { id },
      data: {
        title: product.name,
        imageUrl: normalizeTrendsUrl(product.images?.[0]?.link),
        resolvedProductCode: String(product.code),
        trendsDataJson: JSON.stringify(product),
        trendsFetchedAt: new Date(),
        status: "FETCHED",
        lastError: null,
      },
    });
    return Response.json({
      ok: true,
      code: item.productCode,
      title: product.name,
    });
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : "TRENDS fetch failed"
    ).slice(0, 1000);
    await prisma.syncProduct.update({
      where: { id },
      data: { status: "FAILED", lastError: message },
    });
    return Response.json(
      { ok: false, code: item.productCode, message },
      { status: 502 },
    );
  }
};
