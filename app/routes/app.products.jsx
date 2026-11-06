import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Form,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { parseSkuSheet } from "../lib/sheet-import.server";
import {
  auditTrendsShopifyProducts,
  deleteTrendsShopifyProducts,
  ensureTrendsMetafieldDefinitions,
  getPrimaryLocation,
  getShippingProfiles,
  isTrendsQuoteOnlyError,
  publishProductToOnlineStore,
  shopifyStatusFromTrends,
  syncTrendsProduct,
  syncTrendsPriceAndInventory,
  updateShopifyProductStatus,
  updateTrendsProductConfiguration,
  setConfiguredVariantMetafield,
} from "../lib/shopify-sync.server";
import {
  buildConfiguredVariant,
  parseVariantTypes,
} from "../lib/variant-configuration";
import { TrendsClient } from "../lib/trends.server";
import { normalizeTrendsUrl } from "../lib/trends-url";
import { decryptSecret } from "../lib/crypto.server";
import { classifyProductVariantsWithAi } from "../lib/ai-variant-classifier.server";

const BATCH_SIZE = 20;
const settingsFor = (shop) =>
  prisma.shopSettings.upsert({ where: { shop }, create: { shop }, update: {} });

const readJsonResponse = async (response) => {
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (!body.trim()) return null;
  if (!contentType.toLowerCase().includes("json")) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const loadShopifyProductLinks = async (admin, products) => {
  const ids = [
    ...new Set(
      products
        .flatMap((item) => [item.shopifyProductId, item.shopifyMasterProductId])
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return new Map();
  try {
    const response = await admin.graphql(
      `#graphql
        query TrendsCatalogProductLinks($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              handle
              status
              onlineStoreUrl
            }
          }
        }
      `,
      { variables: { ids } },
    );
    const json = await response.json();
    if (json.errors?.length) return new Map();
    return new Map(
      (json.data?.nodes || []).filter(Boolean).map((item) => [item.id, item]),
    );
  } catch {
    return new Map();
  }
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  await prisma.syncProduct.updateMany({
    where: {
      shop: session.shop,
      status: "SYNCING",
      updatedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
    },
    data: {
      status: "FETCHED",
      lastError: "Previous Shopify sync was interrupted and can be retried.",
    },
  });
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "";
  const requestedSort = url.searchParams.get("sort") || "first";
  const sort = ["first", "last", "az", "za"].includes(requestedSort)
    ? requestedSort
    : requestedSort === "desc"
      ? "last"
      : "first";
  const orderBy =
    sort === "last"
      ? [{ rowNumber: "desc" }, { createdAt: "desc" }]
      : sort === "az"
        ? [{ title: "asc" }, { productCode: "asc" }]
        : sort === "za"
          ? [{ title: "desc" }, { productCode: "desc" }]
          : [{ rowNumber: "asc" }, { createdAt: "asc" }];
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = 25;
  const where = {
    shop: session.shop,
    sourceFile: { not: null },
    ...(search
      ? {
          OR: [
            { productCode: { contains: search } },
            { title: { contains: search } },
            { metadataJson: { contains: search } },
          ],
        }
      : {}),
    ...(status ? { status } : {}),
  };
  const [
    settings,
    products,
    total,
    counts,
    runs,
    fetchAllRows,
    syncAllRows,
    shippingProfiles,
  ] = await Promise.all([
    settingsFor(session.shop),
    prisma.syncProduct.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.syncProduct.count({ where }),
    prisma.syncProduct.groupBy({
      by: ["status"],
      where: {
        shop: session.shop,
        sourceFile: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.syncRun.findMany({
      where: { shop: session.shop },
      orderBy: { startedAt: "desc" },
      take: 5,
    }),
    prisma.syncProduct.findMany({
      where: {
        shop: session.shop,
        sourceFile: { not: null },
        status: { in: ["PENDING", "FAILED"] },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.syncProduct.findMany({
      where: {
        shop: session.shop,
        sourceFile: { not: null },
        trendsDataJson: { not: null },
        status: { not: "QUOTE_ONLY" },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
    getShippingProfiles(admin).catch(() => []),
  ]);
  const selectedShippingProfile = shippingProfiles.find(
    (profile) => profile.id === settings.shippingProfileId,
  );
  const shopifyProductLinks = await loadShopifyProductLinks(admin, products);
  const variantTypes = parseVariantTypes(settings.variantTypesJson);
  return {
    shop: session.shop,
    products: products.map((item) => {
      let configuredVariant = null;
      try {
        const previous = item.configuredVariantJson
          ? JSON.parse(item.configuredVariantJson)
          : { enabled: item.configuredVariantEnabled };
        configuredVariant = item.trendsDataJson
          ? buildConfiguredVariant(
              JSON.parse(item.trendsDataJson),
              variantTypes,
              previous,
            )
          : null;
      } catch {
        configuredVariant = null;
      }
      return {
        ...item,
        configuredVariant:
          configuredVariant?.options?.length || configuredVariant?.aiSuggestion
            ? configuredVariant
            : null,
        mainShopifyProduct: item.shopifyProductId
          ? shopifyProductLinks.get(item.shopifyProductId) || null
          : null,
        masterShopifyProduct: item.shopifyMasterProductId
          ? shopifyProductLinks.get(item.shopifyMasterProductId) || null
          : null,
      };
    }),
    fetchAllIds: fetchAllRows.map((item) => item.id),
    syncAllIds: syncAllRows.map((item) => item.id),
    total,
    counts: Object.fromEntries(
      counts.map((item) => [item.status, item._count._all]),
    ),
    runs,
    configured: Boolean(settings.encryptedTrendsToken),
    globalMarkupPercent: settings.globalMarkupPercent,
    fixedShippingAmount: settings.fixedShippingAmount,
    shippingProfile: settings.shippingProfileId
      ? {
          id: settings.shippingProfileId,
          name: selectedShippingProfile?.name || "Selected Shopify profile",
        }
      : null,
    search,
    status,
    sort,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const settings = await settingsFor(session.shop);
  if (intent === "audit_shopify_sync") {
    const rows = await prisma.syncProduct.findMany({
      where: { shop: session.shop, sourceFile: { not: null } },
      select: {
        id: true,
        productCode: true,
        title: true,
        resolvedProductCode: true,
        trendsDataJson: true,
        status: true,
        lastError: true,
        shopifyProductId: true,
        shopifyMasterProductId: true,
      },
      orderBy: [{ rowNumber: "asc" }, { createdAt: "asc" }],
    });
    try {
      const audit = await auditTrendsShopifyProducts({ admin, rows });
      return {
        ok: true,
        audit,
        message: audit.issues.length
          ? `${audit.issues.length} product(s) need attention · ${audit.repairable} can be repair synced`
          : `All ${audit.checked} products are correctly linked in Shopify`,
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? `Shopify sync check failed: ${error.message}`
            : "Shopify sync check failed",
      };
    }
  }
  if (intent === "generate_ai_variant_suggestion") {
    const id = String(form.get("id") || "");
    if (!settings.aiVariantClassificationEnabled)
      return { ok: false, message: "Enable AI Help in Settings first" };
    if (!settings.encryptedOpenAiApiKey)
      return { ok: false, message: "Save an OpenAI API key in Settings first" };
    const item = await prisma.syncProduct.findFirst({
      where: { id, shop: session.shop },
    });
    if (!item?.trendsDataJson)
      return { ok: false, message: "Fetch the product from TRENDS first" };
    const types = parseVariantTypes(settings.variantTypesJson);
    const source = JSON.parse(item.trendsDataJson);
    const normal = buildConfiguredVariant(
      source,
      types,
      item.configuredVariantJson ? JSON.parse(item.configuredVariantJson) : {},
    );
    try {
      const suggestion = await classifyProductVariantsWithAi({
        apiKey: decryptSecret(settings.encryptedOpenAiApiKey),
        model: settings.aiVariantModel,
        product: source,
        existingOptionTypes: normal.options,
      });
      const configuration = {
        ...normal,
        aiSuggestion: suggestion || {
          status: "no_suggestion",
          source: "ai",
          model: settings.aiVariantModel,
          generatedAt: new Date().toISOString(),
          options: [],
        },
      };
      await prisma.syncProduct.update({
        where: { id },
        data: { configuredVariantJson: JSON.stringify(configuration) },
      });
      return {
        ok: true,
        message: suggestion?.options?.length
          ? `${suggestion.options.length} new option suggestion${suggestion.options.length === 1 ? "" : "s"} ready for review`
          : "AI found no additional variant fields",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "AI Help failed",
      };
    }
  }
  if (intent === "accept_ai_variant_suggestion") {
    const id = String(form.get("id") || "");
    const item = await prisma.syncProduct.findFirst({
      where: { id, shop: session.shop },
    });
    if (!item?.configuredVariantJson)
      return { ok: false, message: "AI suggestion was not found" };
    const previous = JSON.parse(item.configuredVariantJson);
    const suggestion = previous.aiSuggestion;
    if (!suggestion?.options?.length)
      return { ok: false, message: "There are no AI suggestions to accept" };
    const normal = buildConfiguredVariant(
      JSON.parse(item.trendsDataJson || "{}"),
      parseVariantTypes(settings.variantTypesJson),
      previous,
    );
    const existingKeys = new Set(normal.options.map((option) => option.key));
    const acceptedOptions = suggestion.options
      .filter((option) => !existingKeys.has(option.key))
      .map((option) => ({ ...option, source: "ai", manual: true }));
    const options = [...normal.options, ...acceptedOptions];
    const variants = normal.variants.map((variant) => ({
      ...variant,
      attributes: {
        ...variant.attributes,
        ...Object.fromEntries(
          acceptedOptions
            .map((option) => [
              option.name,
              option.matches.find((match) => match.sku === variant.sku)?.value,
            ])
            .filter(([, value]) => value),
        ),
      },
      applicableOptionKeys: options
        .filter((option) =>
          option.matches?.some((match) => match.sku === variant.sku),
        )
        .map((option) => option.key),
    }));
    const configuration = {
      ...normal,
      options,
      variants,
      aiSuggestion: {
        ...suggestion,
        status: "approved",
        approvedAt: new Date().toISOString(),
      },
    };
    await prisma.syncProduct.update({
      where: { id },
      data: { configuredVariantJson: JSON.stringify(configuration) },
    });
    if (item.shopifyProductId) {
      await ensureTrendsMetafieldDefinitions(admin);
      await setConfiguredVariantMetafield({
        admin,
        ownerId: item.shopifyProductId,
        configuration,
      });
    }
    return {
      ok: true,
      message: `${acceptedOptions.length} AI option${acceptedOptions.length === 1 ? "" : "s"} approved`,
    };
  }
  if (intent === "configured_variant") {
    const id = String(form.get("id") || "");
    const enabled = form.get("enabled") === "true";
    let configuration;
    try {
      configuration = JSON.parse(String(form.get("configuration") || "{}"));
    } catch {
      return { ok: false, message: "Variant configuration is invalid" };
    }
    const item = await prisma.syncProduct.findFirst({
      where: { id, shop: session.shop },
    });
    if (!item) return { ok: false, message: "Product was not found" };
    configuration = item.trendsDataJson
      ? buildConfiguredVariant(
          JSON.parse(item.trendsDataJson),
          parseVariantTypes(settings.variantTypesJson),
          { ...configuration, enabled },
        )
      : { ...configuration, enabled, updatedAt: new Date().toISOString() };
    if (!configuration.options?.length) {
      return {
        ok: false,
        message:
          "Assign at least two different values to supplier SKUs before saving",
      };
    }
    await prisma.syncProduct.update({
      where: { id },
      data: {
        configuredVariantEnabled: enabled,
        configuredVariantJson: JSON.stringify(configuration),
      },
    });
    if (item.shopifyProductId) {
      try {
        await ensureTrendsMetafieldDefinitions(admin);
        await setConfiguredVariantMetafield({
          admin,
          ownerId: item.shopifyProductId,
          configuration,
        });
      } catch (error) {
        return {
          ok: false,
          message: `Saved locally, but Shopify metafield failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }
    }
    return { ok: true, message: "Configured variant saved" };
  }
  if (intent === "shopify_status") {
    const ids = [...new Set(form.getAll("productId").map(String))];
    const status = String(form.get("status") || "").toUpperCase();
    if (!ids.length)
      return { ok: false, message: "Select at least one product" };
    if (!["ACTIVE", "DRAFT"].includes(status))
      return { ok: false, message: "Choose Active or Draft" };

    const items = await prisma.syncProduct.findMany({
      where: { shop: session.shop, id: { in: ids } },
      select: {
        id: true,
        shopifyProductId: true,
        shopifyMasterProductId: true,
      },
    });
    const shopifyIds = [
      ...new Set(
        items
          .flatMap((item) => [
            item.shopifyProductId,
            item.shopifyMasterProductId,
          ])
          .filter(Boolean),
      ),
    ];
    if (!shopifyIds.length)
      return {
        ok: false,
        message: "Selected products have not been synced to Shopify yet",
      };

    let updated = 0;
    let failed = 0;
    for (const productId of shopifyIds) {
      try {
        await updateShopifyProductStatus({ admin, productId, status });
        updated++;
      } catch {
        failed++;
      }
    }
    await prisma.syncProduct.updateMany({
      where: { shop: session.shop, id: { in: items.map((item) => item.id) } },
      data: {
        lastSyncedAt: new Date(),
        lastError: failed
          ? `${failed} linked Shopify product status update(s) failed`
          : null,
      },
    });
    return {
      ok: failed === 0,
      message: failed
        ? `${updated} Shopify product(s) set to ${status.toLowerCase()} · ${failed} failed`
        : `${updated} Shopify product(s) set to ${status.toLowerCase()}`,
    };
  }
  if (intent === "import") {
    const file = form.get("skuFile");
    if (file instanceof File && file.size) {
      if (file.size > 5000000)
        return { ok: false, message: "Sheet must be smaller than 5 MB" };
      try {
        const sheet = await parseSkuSheet(file);
        const validRows = [
          ...new Map(
            sheet.items
              .filter((item) => /^\d{6}$/.test(item.code))
              .map((item) => [item.code, item]),
          ).values(),
        ];
        if (!validRows.length)
          return {
            ok: false,
            message:
              'No valid six-digit values found in the "code" or "sku" column',
          };
        const existing = await prisma.syncProduct.findMany({
          where: {
            shop: session.shop,
            productCode: { in: validRows.map((item) => item.code) },
          },
          select: { productCode: true },
        });
        const existingCodes = new Set(existing.map((item) => item.productCode));
        const newRows = validRows.filter(
          (item) => !existingCodes.has(item.code),
        );
        await prisma.$transaction([
          prisma.syncProduct.updateMany({
            where: { shop: session.shop, sourceFile: { not: null } },
            data: { includedInCurrentSheet: true },
          }),
          ...validRows
            .filter((item) => existingCodes.has(item.code))
            .map((item) =>
              prisma.syncProduct.updateMany({
                where: { shop: session.shop, productCode: item.code },
                data: {
                  sourceFile: sheet.name,
                  rowNumber: item.rowNumber,
                  metadataJson: JSON.stringify(item.metadata),
                  tagsJson: JSON.stringify(item.tags),
                  includedInCurrentSheet: true,
                },
              }),
            ),
          ...(newRows.length
            ? [
                prisma.syncProduct.createMany({
                  data: newRows.map((item) => ({
                    shop: session.shop,
                    productCode: item.code,
                    sourceFile: sheet.name,
                    includedInCurrentSheet: true,
                    rowNumber: item.rowNumber,
                    metadataJson: JSON.stringify(item.metadata),
                    tagsJson: JSON.stringify(item.tags),
                    status: "PENDING",
                  })),
                }),
              ]
            : []),
        ]);
        const updated = validRows.length - newRows.length;
        return {
          ok: true,
          message: `${newRows.length} new SKU(s) imported${updated ? ` · ${updated} existing SKU(s) updated` : ""}`,
        };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error ? error.message : "Could not read the sheet",
        };
      }
    }
    return {
      ok: false,
      message:
        'Upload an Excel, CSV or TXT sheet with a "code" or "sku" column',
    };
  }
  if (intent === "fetch") {
    const id = String(form.get("productId") || "");
    const item = await prisma.syncProduct.findFirst({
      where: {
        id,
        shop: session.shop,
        sourceFile: { not: null },
      },
    });
    if (!item) return { ok: false, message: "Sheet item not found" };
    const token = settings.encryptedTrendsToken || "";
    if (!token)
      return {
        ok: false,
        message: "Configure the TRENDS API token in Settings",
      };
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
      return { ok: true, message: `${item.productCode} fetched from TRENDS` };
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : "TRENDS fetch failed"
      ).slice(0, 1000);
      await prisma.syncProduct.update({
        where: { id },
        data: { status: "FAILED", lastError: message },
      });
      return { ok: false, message };
    }
  }
  if (intent === "markup") {
    const mainRaw = String(form.get("individualMarkup") || "").trim();
    const value = mainRaw === "" ? null : Number(mainRaw);
    const customCorporatePackEnabled =
      form.get("customCorporatePackEnabled") === "on";
    if (
      value !== null &&
      (!Number.isFinite(value) || value < 0 || value > 1000)
    )
      return { ok: false, message: "Markup must be between 0% and 1000%" };
    const id = String(form.get("id"));
    await prisma.syncProduct.updateMany({
      where: { id, shop: session.shop },
      data: {
        individualMarkup: value,
        customCorporatePackEnabled,
      },
    });
    const item = await prisma.syncProduct.findFirst({
      where: { id, shop: session.shop },
    });
    if (
      item?.status === "SYNCED" &&
      item.shopifyProductId &&
      item.trendsDataJson
    ) {
      try {
        const locationId = await getPrimaryLocation(
          admin,
          settings.inventoryLocationId,
        );
        const synced = await syncTrendsPriceAndInventory({
          admin,
          shop: session.shop,
          product: JSON.parse(item.trendsDataJson),
          shopifyProductId: item.shopifyProductId,
          shopifyMasterProductId: item.shopifyMasterProductId,
          shopifyAdditionalProductId: item.shopifyAdditionalProductId,
          markupPercent: value ?? settings.globalMarkupPercent,
          fixedShippingAmount: settings.fixedShippingAmount,
          locationId,
          customCorporatePackEnabled,
        });
        await prisma.syncProduct.update({
          where: { id },
          data: {
            shopifyMasterProductId: synced.masterProductId,
            shopifyAdditionalProductId: null,
            lastSyncedAt: new Date(),
            lastError: null,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sync failed";
        await prisma.syncProduct.update({
          where: { id },
          data: { lastError: message.slice(0, 1000) },
        });
        return {
          ok: false,
          message: `Product settings saved, but Shopify update failed: ${message}`,
        };
      }
    }
    return {
      ok: true,
      message: "Product settings saved and applied to Shopify",
    };
  }
  if (intent === "corporate_pack") {
    const id = String(form.get("id") || "");
    const enabled = form.get("enabled") === "true";
    const item = await prisma.syncProduct.findFirst({
      where: { id, shop: session.shop },
    });
    if (!item) return { ok: false, message: "Product was not found" };
    await prisma.syncProduct.update({
      where: { id },
      data: { customCorporatePackEnabled: enabled },
    });
    if (
      item.status === "SYNCED" &&
      item.shopifyProductId &&
      item.trendsDataJson
    ) {
      try {
        await updateTrendsProductConfiguration({
          admin,
          product: JSON.parse(item.trendsDataJson),
          productId: item.shopifyProductId,
          markupPercent: item.individualMarkup ?? settings.globalMarkupPercent,
          fixedShippingAmount: settings.fixedShippingAmount,
          customCorporatePackEnabled: enabled,
        });
        await prisma.syncProduct.update({
          where: { id },
          data: {
            lastSyncedAt: new Date(),
            lastError: null,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sync failed";
        await prisma.syncProduct.update({
          where: { id },
          data: { lastError: message.slice(0, 1000) },
        });
        return {
          ok: false,
          message: `Corporate pack preference saved, but Shopify update failed: ${message}`,
        };
      }
    }
    return {
      ok: true,
      message: enabled
        ? "Custom Corporate Pack enabled"
        : "Custom Corporate Pack disabled",
    };
  }
  if (intent === "bulk_corporate_pack") {
    const ids = [...new Set(form.getAll("productId").map(String))];
    const enabled = form.get("enabled") === "true";
    if (!ids.length)
      return { ok: false, message: "Select at least one product" };
    const items = await prisma.syncProduct.findMany({
      where: { shop: session.shop, id: { in: ids } },
    });
    if (!items.length) return { ok: false, message: "No products were found" };
    await prisma.syncProduct.updateMany({
      where: { shop: session.shop, id: { in: items.map((item) => item.id) } },
      data: { customCorporatePackEnabled: enabled },
    });
    let updated = 0;
    let failed = 0;
    for (const item of items) {
      if (
        item.status !== "SYNCED" ||
        !item.shopifyProductId ||
        !item.trendsDataJson
      ) {
        updated++;
        continue;
      }
      try {
        await updateTrendsProductConfiguration({
          admin,
          product: JSON.parse(item.trendsDataJson),
          productId: item.shopifyProductId,
          markupPercent: item.individualMarkup ?? settings.globalMarkupPercent,
          fixedShippingAmount: settings.fixedShippingAmount,
          customCorporatePackEnabled: enabled,
        });
        await prisma.syncProduct.update({
          where: { id: item.id },
          data: { lastSyncedAt: new Date(), lastError: null },
        });
        updated++;
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : "Sync failed";
        await prisma.syncProduct.update({
          where: { id: item.id },
          data: { lastError: message.slice(0, 1000) },
        });
      }
    }
    return {
      ok: failed === 0,
      message: failed
        ? `${updated} product(s) updated · ${failed} Shopify update(s) need attention`
        : `Custom Corporate Pack ${enabled ? "enabled" : "disabled"} for ${updated} product(s)`,
    };
  }
  if (intent === "remove" || intent === "remove_shopify") {
    const ids = form.getAll("productId").map(String);
    const items = await prisma.syncProduct.findMany({
      where: { shop: session.shop, id: { in: ids } },
      select: {
        id: true,
        shopifyProductId: true,
        shopifyMasterProductId: true,
        shopifyAdditionalProductId: true,
        resolvedProductCode: true,
        trendsDataJson: true,
      },
    });
    if (!items.length) return { ok: false, message: "No items found" };
    let deletedFromShopify = 0;
    try {
      deletedFromShopify = await deleteTrendsShopifyProducts({ admin, items });
    } catch (error) {
      return {
        ok: false,
        message: `Shopify deletion failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
    if (intent === "remove") {
      await prisma.syncProduct.deleteMany({
        where: { shop: session.shop, id: { in: ids } },
      });
    } else {
      await prisma.$transaction(
        items.map((item) =>
          prisma.syncProduct.update({
            where: { id: item.id },
            data: {
              shopifyProductId: null,
              shopifyMasterProductId: null,
              shopifyAdditionalProductId: null,
              lastSyncedAt: null,
              status: item.trendsDataJson ? "FETCHED" : "PENDING",
              lastError: null,
            },
          }),
        ),
      );
    }
    return {
      ok: true,
      message:
        intent === "remove"
          ? `${items.length} item(s) removed from the list${deletedFromShopify ? ` · ${deletedFromShopify} Shopify product(s) deleted` : ""}`
          : `${deletedFromShopify} Shopify product(s) deleted · ${items.length} list item(s) retained`,
    };
  }
  if (intent === "publish_online_store") {
    const ids = form.getAll("productId").map(String);
    const items = await prisma.syncProduct.findMany({
      where: {
        shop: session.shop,
        status: "SYNCED",
        shopifyProductId: { not: null },
        ...(ids.length ? { id: { in: ids } } : {}),
      },
    });
    const activeItems = [
      ...new Map(
        items
          .filter((item) => {
            try {
              return (
                shopifyStatusFromTrends(
                  JSON.parse(item.trendsDataJson || "{}"),
                ) === "ACTIVE"
              );
            } catch {
              return true;
            }
          })
          .map((item) => [item.shopifyProductId, item]),
      ).values(),
    ];
    let published = 0;
    let failed = 0;
    const queue = [...activeItems];
    await Promise.all(
      Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          try {
            await publishProductToOnlineStore(admin, item.shopifyProductId);
            await prisma.syncProduct.updateMany({
              where: {
                shop: session.shop,
                shopifyProductId: item.shopifyProductId,
              },
              data: { lastError: null },
            });
            published++;
          } catch (error) {
            failed++;
            await prisma.syncProduct.updateMany({
              where: {
                shop: session.shop,
                shopifyProductId: item.shopifyProductId,
              },
              data: {
                lastError: `Online Store publishing: ${(error instanceof Error
                  ? error.message
                  : "Publishing failed"
                ).slice(0, 900)}`,
              },
            });
          }
        }
      }),
    );
    return {
      ok: failed === 0,
      message: `${published} product(s) published to Online Store${failed ? ` · ${failed} failed` : ""}${items.length - activeItems.length ? ` · ${items.length - activeItems.length} draft product(s) skipped` : ""}`,
    };
  }
  if (intent === "recover_sync") {
    const ids = form.getAll("productId").map(String).filter(Boolean);
    if (ids.length) {
      await prisma.syncProduct.updateMany({
        where: {
          shop: session.shop,
          id: { in: ids },
          status: "SYNCING",
        },
        data: {
          status: "FETCHED",
          lastError: "Shopify sync response was interrupted. Please retry.",
        },
      });
    }
    return { ok: true, recovered: ids.length };
  }
  if (intent === "sync") {
    const ids = form.getAll("productId").map(String);
    const where = ids.length
      ? {
          shop: session.shop,
          id: { in: ids },
          sourceFile: { not: null },
        }
      : {
          shop: session.shop,
          status: { in: ["PENDING", "FAILED"] },
          sourceFile: { not: null },
        };
    const queued = (
      await prisma.syncProduct.findMany({
        where,
        orderBy: { createdAt: "asc" },
        ...(ids.length ? {} : { take: BATCH_SIZE }),
      })
    ).filter((item) => item.trendsDataJson);
    if (!queued.length)
      return {
        ok: false,
        message: "Fetch the selected SKUs from TRENDS before syncing",
      };
    let metafieldPreparationWarning = "";
    try {
      await ensureTrendsMetafieldDefinitions(admin);
    } catch (error) {
      metafieldPreparationWarning =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : error?.message ||
              error?.statusText ||
              "Shopify API request failed";
      console.warn(
        `TRENDS metafield definition preparation was skipped: ${metafieldPreparationWarning}`,
      );
    }
    const run = await prisma.syncRun.create({
      data: { shop: session.shop, requested: queued.length },
    });
    const locationId = await getPrimaryLocation(
      admin,
      settings.inventoryLocationId,
    );
    let succeeded = 0;
    let failed = 0;
    let quoteOnly = 0;
    const groups = new Map();
    for (const item of queued) {
      try {
        const product = JSON.parse(item.trendsDataJson);
        const key = String(product.code);
        const group = groups.get(key) || {
          product,
          items: [],
          tags: new Set(),
          markup: null,
          customCorporatePackEnabled: false,
        };
        group.items.push(item);
        JSON.parse(item.tagsJson || "[]").forEach((tag) => group.tags.add(tag));
        if (item.individualMarkup !== null)
          group.markup = item.individualMarkup;
        if (item.customCorporatePackEnabled)
          group.customCorporatePackEnabled = true;
        groups.set(key, group);
      } catch (error) {
        await prisma.syncProduct.update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            lastError: (error instanceof Error
              ? error.message
              : "Unknown error"
            ).slice(0, 1000),
          },
        });
        failed++;
      }
    }
    for (const group of groups.values()) {
      await prisma.syncProduct.updateMany({
        where: { id: { in: group.items.map((item) => item.id) } },
        data: { status: "SYNCING", lastError: null },
      });
      try {
        const synced = await syncTrendsProduct({
          admin,
          shop: session.shop,
          product: group.product,
          shopifyProductId:
            group.items.find((item) => item.shopifyProductId)
              ?.shopifyProductId || null,
          shopifyMasterProductId:
            group.items.find((item) => item.shopifyMasterProductId)
              ?.shopifyMasterProductId || null,
          shopifyAdditionalProductId:
            group.items.find((item) => item.shopifyAdditionalProductId)
              ?.shopifyAdditionalProductId || null,
          markupPercent: group.markup ?? settings.globalMarkupPercent,
          fixedShippingAmount: settings.fixedShippingAmount,
          locationId,
          extraTags: [...group.tags],
          templateSuffix: settings.productTemplateSuffix,
          selectedPublicationIds: settings.selectedPublicationIdsJson
            ? JSON.parse(settings.selectedPublicationIdsJson)
            : null,
          shippingProfileId: settings.shippingProfileId,
          customCorporatePackEnabled: group.customCorporatePackEnabled,
        });
        await prisma.syncProduct.updateMany({
          where: { id: { in: group.items.map((item) => item.id) } },
          data: {
            title: group.product.name,
            resolvedProductCode: String(group.product.code),
            imageUrl: normalizeTrendsUrl(group.product.images?.[0]?.link),
            status: "SYNCED",
            shopifyProductId: synced.id,
            shopifyMasterProductId: synced.masterProductId,
            shopifyAdditionalProductId:
              synced.additionalProducts?.[0]?.id || null,
            lastSyncedAt: new Date(),
            lastError: null,
          },
        });
        succeeded += group.items.length;
      } catch (error) {
        const message = (
          error instanceof Error ? error.message : "Unknown error"
        ).slice(0, 1000);
        const isQuoteOnly = isTrendsQuoteOnlyError(error);
        await prisma.syncProduct.updateMany({
          where: { id: { in: group.items.map((item) => item.id) } },
          data: {
            status: isQuoteOnly ? "QUOTE_ONLY" : "FAILED",
            lastError: message,
          },
        });
        if (isQuoteOnly) quoteOnly += group.items.length;
        else failed += group.items.length;
      }
    }
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        succeeded,
        failed,
        status: failed ? (succeeded ? "PARTIAL" : "FAILED") : "COMPLETED",
        finishedAt: new Date(),
      },
    });
    return {
      ok: failed === 0,
      requested: queued.length,
      succeeded,
      failed,
      quoteOnly,
      message: `${succeeded} synced${quoteOnly ? ` · ${quoteOnly} quote-only product(s) skipped safely` : ""}${failed ? ` · ${failed} failed` : ""}${metafieldPreparationWarning ? " · metafield definition setup was skipped, but product metafields were still written" : ""}`,
    };
  }
  return { ok: false, message: "Unknown action" };
};

const storefrontUrlFor = (item, shop) =>
  item.mainShopifyProduct?.onlineStoreUrl ||
  (item.mainShopifyProduct?.handle
    ? `https://${shop}/products/${encodeURIComponent(item.mainShopifyProduct.handle)}`
    : null);

export default function ProductSync() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const importer = useFetcher();
  const variantFetcher = useFetcher();
  const auditFetcher = useFetcher();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [selected, setSelected] = useState([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [variantItem, setVariantItem] = useState(null);
  const handledVariantResponse = useRef(null);
  const handledFetcherResponse = useRef(null);
  const [markupItem, setMarkupItem] = useState(null);
  const [priceItem, setPriceItem] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditSelected, setAuditSelected] = useState([]);
  const [latestAudit, setLatestAudit] = useState(null);
  const [activeIntent, setActiveIntent] = useState("");
  const [activeProductIds, setActiveProductIds] = useState([]);
  const [corporatePackOverrides, setCorporatePackOverrides] = useState({});
  const [file, setFile] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [draggingFile, setDraggingFile] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const fileInputRef = useRef(null);
  const [progress, setProgress] = useState(null);
  const busy =
    fetcher.state !== "idle" ||
    auditFetcher.state !== "idle" ||
    Boolean(progress);
  const importing = importer.state !== "idle";
  useEffect(() => {
    if (
      variantFetcher.state === "idle" &&
      variantFetcher.data?.message &&
      handledVariantResponse.current !== variantFetcher.data
    ) {
      handledVariantResponse.current = variantFetcher.data;
      shopify.toast.show(variantFetcher.data.message, {
        isError: !variantFetcher.data.ok,
      });
      if (variantFetcher.data.ok) {
        setVariantItem(null);
        revalidator.revalidate();
      }
    }
  }, [variantFetcher.state, variantFetcher.data, shopify, revalidator]);
  const selectUploadFile = (nextFile) => {
    setUploadError("");
    if (!nextFile) {
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const extension = nextFile.name.toLowerCase().split(".").pop();
    if (!["xlsx", "csv", "txt"].includes(extension)) {
      setFile(null);
      setUploadError("Choose an Excel (.xlsx), CSV or TXT file.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (nextFile.size > 5_000_000) {
      setFile(null);
      setUploadError("The selected file is larger than the 5 MB limit.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFile(nextFile);
  };
  const closeUpload = () => {
    if (importing) return;
    setUploadOpen(false);
    setDraggingFile(false);
    setUploadError("");
    setFile(null);
  };
  useEffect(() => {
    if (navigation.state === "idle") setFiltering(false);
  }, [navigation.state]);
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.message &&
      handledFetcherResponse.current !== fetcher.data
    ) {
      handledFetcherResponse.current = fetcher.data;
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
      if (fetcher.data.ok && activeIntent === "markup") setMarkupItem(null);
      if (fetcher.state === "idle") {
        if (activeIntent === "corporate_pack") {
          setCorporatePackOverrides({});
        }
        setActiveIntent("");
        setActiveProductIds([]);
      }
    }
  }, [fetcher.data, fetcher.state, shopify, activeIntent]);
  useEffect(() => {
    if (importer.data?.message) {
      shopify.toast.show(importer.data.message, { isError: !importer.data.ok });
      if (importer.data.ok) {
        setUploadOpen(false);
        setFile(null);
      }
    }
  }, [importer.data, shopify]);
  useEffect(() => {
    if (auditFetcher.state !== "idle" || !auditFetcher.data) return;
    if (!auditFetcher.data.ok) {
      shopify.toast.show(
        auditFetcher.data.message || "Shopify sync check failed",
        { isError: true },
      );
      return;
    }
    const repairableIds = (auditFetcher.data.audit?.issues || [])
      .filter((item) => item.canSync)
      .map((item) => item.id);
    setAuditSelected(repairableIds);
    setLatestAudit(auditFetcher.data.audit);
    setAuditOpen(true);
  }, [auditFetcher.state, auditFetcher.data, shopify]);
  const runSyncAudit = () => {
    const form = new FormData();
    form.set("intent", "audit_shopify_sync");
    auditFetcher.submit(form, { method: "POST" });
  };
  const submit = (intent, ids = selected) => {
    setActiveIntent(intent);
    setActiveProductIds([]);
    const form = new FormData();
    form.set("intent", intent);
    ids.forEach((id) => form.append("productId", id));
    fetcher.submit(form, { method: "POST" });
  };
  const updateCorporatePack = (product, enabled) => {
    setCorporatePackOverrides((current) => ({
      ...current,
      [product.id]: enabled,
    }));
    setActiveIntent("corporate_pack");
    setActiveProductIds([product.id]);
    const form = new FormData();
    form.set("intent", "corporate_pack");
    form.set("id", product.id);
    form.set("enabled", String(enabled));
    fetcher.submit(form, { method: "POST" });
  };
  const updateBulkCorporatePack = (enabled) => {
    setActiveIntent("bulk_corporate_pack");
    setActiveProductIds(selected);
    const form = new FormData();
    form.set("intent", "bulk_corporate_pack");
    form.set("enabled", String(enabled));
    selected.forEach((id) => form.append("productId", id));
    fetcher.submit(form, { method: "POST" });
  };
  const updateShopifyStatus = (ids, status) => {
    if (!ids.length || !status) return;
    setActiveIntent("shopify_status");
    setActiveProductIds([]);
    const form = new FormData();
    form.set("intent", "shopify_status");
    form.set("status", status);
    ids.forEach((id) => form.append("productId", id));
    fetcher.submit(form, { method: "POST" });
  };
  const fetchProducts = async (ids) => {
    if (!ids.length) return;
    let failed = 0;
    setProgress({
      label: "Fetching product details from TRENDS",
      current: 0,
      total: ids.length,
      failed: 0,
    });
    for (let i = 0; i < ids.length; i++) {
      const form = new FormData();
      form.set("productId", ids[i]);
      try {
        const response = await fetch(`/app/fetch${window.location.search}`, {
          method: "POST",
          body: form,
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const result = await readJsonResponse(response);
        if (!result) {
          failed++;
          shopify.toast.show(
            "The product response could not be confirmed. Please retry this item.",
            { isError: true },
          );
        } else if (!response.ok || !result.ok) {
          failed++;
          shopify.toast.show(result.message || "TRENDS fetch failed", {
            isError: true,
          });
        }
      } catch (error) {
        failed++;
        shopify.toast.show(
          error instanceof Error ? error.message : "TRENDS fetch failed",
          { isError: true },
        );
      }
      setProgress({
        label: "Fetching product details from TRENDS",
        current: i + 1,
        total: ids.length,
        failed,
      });
      if ((i + 1) % 10 === 0 || i + 1 === ids.length) {
        await revalidator.revalidate();
      }
    }
    if (!failed) shopify.toast.show(`${ids.length} product detail(s) fetched`);
    setTimeout(() => setProgress(null), 900);
  };
  const syncProducts = async (ids, verifyAfter = false) => {
    if (!ids.length) return;
    // One request per product keeps the UI count and percentage accurate and
    // prevents one slow product from leaving the other two in its batch stuck.
    const batchSize = 1;
    let completed = 0;
    let failed = 0;
    let quoteOnly = 0;
    let unconfirmed = 0;
    let responseNoticeShown = false;
    setActiveIntent("sync");
    setActiveProductIds(ids);
    setProgress({
      label: "Syncing products to Shopify",
      current: 0,
      total: ids.length,
      failed: 0,
    });
    for (let index = 0; index < ids.length; index += batchSize) {
      const batch = ids.slice(index, index + batchSize);
      setActiveProductIds(batch);
      const form = new FormData();
      form.set("intent", "sync");
      batch.forEach((id) => form.append("productId", id));
      try {
        const response = await fetch(
          `${window.location.pathname}${window.location.search}`,
          {
            method: "POST",
            body: form,
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          },
        );
        const result = await readJsonResponse(response);
        if (!result) {
          unconfirmed += batch.length;
          const recoveryForm = new FormData();
          recoveryForm.set("intent", "recover_sync");
          batch.forEach((id) => recoveryForm.append("productId", id));
          await fetch(`${window.location.pathname}${window.location.search}`, {
            method: "POST",
            body: recoveryForm,
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          }).catch(() => null);
          if (!responseNoticeShown) {
            shopify.toast.show(
              "Shopify is still processing the sync. Progress will continue and product statuses will be refreshed.",
            );
            responseNoticeShown = true;
          }
        } else {
          const reportedFailed = Number(result.failed);
          quoteOnly += Number(result.quoteOnly) || 0;
          failed +=
            response.ok && Number.isFinite(reportedFailed)
              ? reportedFailed
              : batch.length;
        }
        if (result && (!response.ok || !result.ok)) {
          shopify.toast.show(result.message || "Shopify sync failed", {
            isError: true,
          });
        }
      } catch (error) {
        failed += batch.length;
        const recoveryForm = new FormData();
        recoveryForm.set("intent", "recover_sync");
        batch.forEach((id) => recoveryForm.append("productId", id));
        await fetch(`${window.location.pathname}${window.location.search}`, {
          method: "POST",
          body: recoveryForm,
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        }).catch(() => null);
        shopify.toast.show(
          error instanceof Error ? error.message : "Shopify sync failed",
          { isError: true },
        );
      }
      completed += batch.length;
      setProgress({
        label: "Syncing products to Shopify",
        current: completed,
        total: ids.length,
        failed,
      });
      await revalidator.revalidate();
    }
    await revalidator.revalidate();
    shopify.toast.show(
      failed
        ? `${ids.length - failed - quoteOnly} synced · ${quoteOnly} quote-only · ${failed} need attention`
        : unconfirmed
          ? "Sync completed. Product statuses have been refreshed for confirmation."
          : quoteOnly
            ? `${ids.length - quoteOnly} synced · ${quoteOnly} quote-only product skipped safely`
            : `${ids.length} product(s) synced to Shopify`,
      { isError: failed > 0 },
    );
    setSelected([]);
    setActiveIntent("");
    setActiveProductIds([]);
    setTimeout(() => setProgress(null), 1200);
    if (verifyAfter) setTimeout(runSyncAudit, 1500);
  };
  const allChecked =
    data.products.length > 0 &&
    data.products.every((p) => selected.includes(p.id));
  const fetched = (data.counts.FETCHED || 0) + (data.counts.SYNCED || 0);
  return (
    <s-page heading="Trends Products" inlineSize="large">
      <div className="trends-shell">
        {!data.configured && (
          <s-banner tone="critical" heading="TRENDS connection required">
            Open Settings and save the API token before fetching products.
          </s-banner>
        )}
        <div className="trends-metrics">
          <QueueMetric
            label="Total TRENDS products"
            value={Object.values(data.counts).reduce((a, b) => a + b, 0)}
          />
          <QueueMetric label="Details fetched" value={fetched} tone="success" />
          <QueueMetric
            label={latestAudit ? "Verified Shopify mains" : "Synced to Shopify"}
            value={latestAudit?.mainProducts ?? data.counts.SYNCED ?? 0}
            tone="success"
          />
          <QueueMetric
            label="Needs attention"
            value={data.counts.FAILED || 0}
            tone="critical"
          />
        </div>
        {progress && <ProgressPanel progress={progress} />}
        <div className="trends-card">
          <div className="trends-card__header trends-product-management-header">
            <div className="trends-product-management-copy">
              <h3>Product management</h3>
              <p>
                Import product SKUs, retrieve the latest supplier data, and
                manage synchronization with Shopify.
              </p>
            </div>
            <div className="trends-actions trends-product-management-actions">
              <s-button
                icon="search"
                loading={auditFetcher.state !== "idle"}
                disabled={busy || !data.configured}
                onClick={runSyncAudit}
              >
                Check issues
              </s-button>
              <s-button
                variant="primary"
                icon="refresh"
                disabled={!data.syncAllIds.length || busy || !data.configured}
                onClick={() =>
                  setConfirm({
                    type: "sync_all_info",
                    ids: data.syncAllIds,
                    title: `Sync all ${data.syncAllIds.length} products now?`,
                    body: "This updates every fetched product in Shopify using the latest saved TRENDS information, including product details, variants, prices, inventory, images, tags, publishing settings and configured metafields. The operation may take several minutes.",
                  })
                }
              >
                Sync all
              </s-button>
              <s-button onClick={() => setUploadOpen(true)} disabled={busy}>
                Upload sheet
              </s-button>
              <s-button
                disabled={!data.fetchAllIds.length || busy || !data.configured}
                onClick={() => fetchProducts(data.fetchAllIds)}
              >
                Fetch all ({data.fetchAllIds.length})
              </s-button>
              <s-button
                variant="primary"
                disabled={!selected.length || busy || !data.configured}
                onClick={() => fetchProducts(selected)}
              >
                Fetch selected ({selected.length})
              </s-button>
            </div>
          </div>
          <div className="trends-card__body">
            <Form method="get" onSubmit={() => setFiltering(true)}>
              <div className="trends-toolbar trends-toolbar--sorting">
                <label className="trends-field">
                  Search products
                  <input
                    className="trends-input"
                    name="q"
                    defaultValue={data.search}
                    placeholder="Search title, SKU or sheet data"
                  />
                </label>
                <label className="trends-field">
                  Status
                  <select
                    className="trends-input"
                    name="status"
                    defaultValue={data.status}
                  >
                    <option value="">All statuses</option>
                    <option value="PENDING">Pending fetch</option>
                    <option value="FETCHED">Fetched</option>
                    <option value="SYNCED">Synced items</option>
                    <option value="QUOTE_ONLY">Quote-only items</option>
                    <option value="FAILED">Failed</option>
                  </select>
                </label>
                <label className="trends-field">
                  Display order
                  <select
                    className="trends-input"
                    name="sort"
                    defaultValue={data.sort}
                  >
                    <option value="first">First item first</option>
                    <option value="last">Last item first</option>
                    <option value="az">A–Z</option>
                    <option value="za">Z–A</option>
                  </select>
                </label>
                <button
                  className="trends-filter-button"
                  type="submit"
                  disabled={filtering}
                  aria-busy={filtering}
                >
                  {filtering && (
                    <span
                      className="trends-filter-spinner"
                      aria-hidden="true"
                    />
                  )}
                  <span>{filtering ? "Applying…" : "Apply filters"}</span>
                </button>
              </div>
            </Form>
          </div>
          {selected.length > 0 && (
            <div className="trends-bulkbar">
              <strong>{selected.length} selected</strong>
              <s-button onClick={() => fetchProducts(selected)} disabled={busy}>
                Fetch details
              </s-button>
              <s-button
                onClick={() =>
                  setConfirm({
                    type: "publish_online_store",
                    ids: selected,
                    title: `Publish ${selected.length} selected product(s)?`,
                    body: "Active products will be published to the Online Store sales channel. Draft products will be skipped.",
                  })
                }
                disabled={busy}
              >
                Publish Online Store
              </s-button>
              <s-button
                onClick={() =>
                  setConfirm({
                    type: "sync",
                    ids: selected,
                    title: `Sync ${selected.length} selected product(s) to Shopify?`,
                    body: "Fetched product data, variants, inventory, images and pricing will be created or updated in Shopify.",
                  })
                }
                disabled={busy}
              >
                Sync to Shopify
              </s-button>
              <s-button
                onClick={() => updateBulkCorporatePack(true)}
                disabled={busy}
              >
                Enable corporate pack
              </s-button>
              <s-button
                onClick={() => updateBulkCorporatePack(false)}
                disabled={busy}
              >
                Disable corporate pack
              </s-button>
              <label className="trends-bulk-status-control">
                <span>Store status</span>
                <span className="trends-status-select-shell">
                  <select
                    value=""
                    disabled={busy}
                    onChange={(event) => {
                      updateShopifyStatus(selected, event.target.value);
                    }}
                  >
                    <option value="" disabled>
                      Set status…
                    </option>
                    <option value="ACTIVE">Active</option>
                    <option value="DRAFT">Draft</option>
                  </select>
                  {activeIntent === "shopify_status" &&
                  fetcher.state !== "idle" ? (
                    <span
                      className="trends-inline-spinner"
                      aria-label="Updating selected Shopify product statuses"
                    />
                  ) : null}
                </span>
              </label>
              <s-button
                tone="critical"
                onClick={() =>
                  setConfirm({
                    type: "remove",
                    ids: selected,
                    title: `Delete ${selected.length} selected item(s)?`,
                    body: "Choose whether to delete the linked main and additional-cost products from Shopify only, or delete them from Shopify and remove the selected rows from this list as well.",
                  })
                }
                disabled={busy}
              >
                Delete
              </s-button>
            </div>
          )}
          {data.products.length ? (
            <div className="trends-table-wrap">
              <table className="trends-table trends-products-table">
                <colgroup>
                  <col className="trends-col-select" />
                  <col className="trends-col-count" />
                  <col className="trends-col-product" />
                  <col className="trends-col-updated" />
                  <col className="trends-col-markup" />
                  <col className="trends-col-status" />
                  <col className="trends-col-shopify-status" />
                  <col className="trends-col-corporate" />
                  <col className="trends-col-sync" />
                  <col className="trends-col-details" />
                  <col className="trends-col-actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all products on this page"
                        checked={allChecked}
                        onChange={() =>
                          setSelected(
                            allChecked
                              ? selected.filter(
                                  (id) =>
                                    !data.products.some((p) => p.id === id),
                                )
                              : [
                                  ...new Set([
                                    ...selected,
                                    ...data.products.map((p) => p.id),
                                  ]),
                                ],
                          )
                        }
                      />
                    </th>
                    <th>#</th>
                    <th className="trends-heading-product">Product</th>
                    <th className="trends-heading-updated">Updated</th>
                    <th>Pricing</th>
                    <th className="trends-heading-centered">Sync state</th>
                    <th className="trends-heading-centered">Store status</th>
                    <th>Corporate pack</th>
                    <th>Update</th>
                    <th>Details</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((product, index) => (
                    <tr key={product.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.includes(product.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...new Set([...selected, product.id])]
                                : selected.filter((id) => id !== product.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <span className="trends-row-count">
                          {data.sort !== "last"
                            ? (data.page - 1) * data.pageSize + index + 1
                            : data.total -
                              ((data.page - 1) * data.pageSize + index)}
                        </span>
                      </td>
                      <td>
                        <div className="trends-product">
                          <span className="trends-thumb">
                            {product.imageUrl ? (
                              <img src={product.imageUrl} alt="" />
                            ) : (
                              "—"
                            )}
                          </span>
                          <span className="trends-product__name">
                            <strong className="trends-product__title">
                              {product.title || "Details not fetched"}
                            </strong>
                            <small className="trends-product__sub">
                              SKU: {product.productCode}
                            </small>
                            {product.trendsDataJson && (
                              <span className="trends-product-variant-tools">
                                <button
                                  type="button"
                                  className={`trends-variant-chip${product.configuredVariant ? " is-configured" : " is-manual"}`}
                                  title="Open variant configuration"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setVariantItem({ ...product });
                                  }}
                                >
                                  ◇{" "}
                                  {product.configuredVariant
                                    ? "Configured variants"
                                    : "Configure variants"}
                                </button>
                                {product.configuredVariant?.aiSuggestion && (
                                  <span
                                    className={`trends-source-badge ${product.configuredVariant.aiSuggestion.status === "approved" ? "is-ai-approved" : "is-ai"}`}
                                  >
                                    {product.configuredVariant.aiSuggestion
                                      .status === "approved"
                                      ? "AI approved"
                                      : "AI suggestion"}
                                  </span>
                                )}
                              </span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td className="trends-updated-cell">
                        {renderUpdatedAt(
                          product.trendsFetchedAt || product.lastSyncedAt,
                        )}
                      </td>
                      <td>
                        <button
                          className="trends-markup-button"
                          onClick={() => setMarkupItem(product)}
                          aria-label={`Configure pricing and markup for ${product.productCode}`}
                        >
                          <span
                            className="trends-markup-button__icon"
                            aria-hidden="true"
                          >
                            <svg viewBox="0 0 24 24" width="18" height="18">
                              <path d="M4 19V9m5 10V5m5 14v-7m5 7V3" />
                            </svg>
                          </span>
                          <span className="trends-markup-button__content">
                            <strong>Configure pricing</strong>
                            <small>
                              Effective markup{" "}
                              {product.individualMarkup ??
                                data.globalMarkupPercent}
                              % ·{" "}
                              <s-badge
                                tone={
                                  product.individualMarkup == null
                                    ? "info"
                                    : "success"
                                }
                              >
                                {product.individualMarkup == null
                                  ? "Global"
                                  : "Individual"}
                              </s-badge>
                            </small>
                          </span>
                          <span
                            className="trends-markup-button__action"
                            aria-hidden="true"
                          >
                            ›
                          </span>
                        </button>
                      </td>
                      <td className="trends-cell-centered trends-sync-state-cell">
                        <div className="trends-sync-state-value">
                          <StatusBadge
                            status={
                              activeIntent === "sync" &&
                              activeProductIds.includes(product.id)
                                ? "SYNCING"
                                : product.status
                            }
                          />
                        </div>
                        {["FAILED", "QUOTE_ONLY"].includes(product.status) &&
                          product.lastError && (
                            <small className="trends-error">
                              {product.lastError}
                            </small>
                          )}
                      </td>
                      <td className="trends-cell-centered trends-store-status-cell">
                        <label className="trends-shopify-status-control">
                          <span className="trends-status-select-shell">
                            <select
                              aria-label={`Shopify status for ${product.productCode}`}
                              className={`is-${String(product.mainShopifyProduct?.status || "unknown").toLowerCase()}`}
                              value={
                                ["ACTIVE", "DRAFT"].includes(
                                  product.mainShopifyProduct?.status,
                                )
                                  ? product.mainShopifyProduct.status
                                  : ""
                              }
                              disabled={!product.shopifyProductId || busy}
                              onChange={(event) =>
                                updateShopifyStatus(
                                  [product.id],
                                  event.target.value,
                                )
                              }
                            >
                              <option value="" disabled>
                                {product.shopifyProductId ? "—" : "Not synced"}
                              </option>
                              <option value="ACTIVE">Active</option>
                              <option value="DRAFT">Draft</option>
                            </select>
                            {activeIntent === "shopify_status" &&
                            activeProductIds.includes(product.id) &&
                            fetcher.state !== "idle" ? (
                              <span
                                className="trends-inline-spinner"
                                aria-label="Updating Shopify product status"
                              />
                            ) : null}
                          </span>
                        </label>
                      </td>
                      <td>
                        <label
                          className="trends-corporate-toggle"
                          title="Offer Custom Corporate Pack for this product"
                        >
                          <input
                            type="checkbox"
                            aria-label={`Offer Custom Corporate Pack for ${product.productCode}`}
                            checked={
                              corporatePackOverrides[product.id] ??
                              product.customCorporatePackEnabled
                            }
                            disabled={busy || !product.trendsDataJson}
                            onChange={(event) =>
                              updateCorporatePack(product, event.target.checked)
                            }
                          />
                          {activeIntent === "corporate_pack" &&
                            activeProductIds.includes(product.id) && (
                              <span
                                className="trends-inline-spinner"
                                aria-label="Saving corporate pack setting"
                              />
                            )}
                        </label>
                      </td>
                      <td>
                        <div className="trends-sync-action">
                          <span title="Sync or update Shopify product">
                            <s-button
                              variant="tertiary"
                              icon="refresh"
                              accessibilityLabel="Sync or update product in Shopify"
                              loading={
                                activeIntent === "sync" &&
                                activeProductIds.includes(product.id) &&
                                Boolean(progress)
                              }
                              disabled={!product.trendsDataJson || busy}
                              onClick={() =>
                                setConfirm({
                                  type: "sync",
                                  ids: [product.id],
                                  title: `Sync ${product.productCode} to Shopify?`,
                                  body: "This product and all fetched variants will be created or updated in Shopify.",
                                })
                              }
                            />
                          </span>
                        </div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="trends-view-details-button"
                          disabled={!product.trendsDataJson}
                          onClick={() => setDetails(product)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
                            <circle cx="12" cy="12" r="2.5" />
                          </svg>
                          <span>Details</span>
                        </button>
                      </td>
                      <td>
                        <div className="trends-row-actions">
                          <span title="View product on storefront">
                            <s-button
                              variant="tertiary"
                              icon="view"
                              accessibilityLabel="View product on storefront"
                              disabled={!storefrontUrlFor(product, data.shop)}
                              onClick={() => {
                                const storefrontUrl = storefrontUrlFor(
                                  product,
                                  data.shop,
                                );
                                if (storefrontUrl)
                                  window.open(
                                    storefrontUrl,
                                    "_blank",
                                    "noopener,noreferrer",
                                  );
                              }}
                            />
                          </span>
                          <span title="Delete product">
                            <s-button
                              variant="tertiary"
                              icon="delete"
                              tone="critical"
                              accessibilityLabel="Delete product"
                              loading={
                                ["remove", "remove_shopify"].includes(
                                  activeIntent,
                                ) &&
                                activeProductIds.includes(product.id) &&
                                fetcher.state !== "idle"
                              }
                              disabled={busy}
                              onClick={() =>
                                setConfirm({
                                  type: "remove",
                                  ids: [product.id],
                                  title: `Delete ${product.productCode}?`,
                                  body: "Choose whether to delete the linked main and additional-cost products from Shopify only, or delete them from Shopify and remove this row from the list as well.",
                                })
                              }
                            />
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="trends-empty">
              <div className="trends-empty__icon">▤</div>
              <h3>No TRENDS products yet</h3>
              <p>Upload a spreadsheet to create your SKU list.</p>
              <div style={{ marginTop: 14 }}>
                <s-button variant="primary" onClick={() => setUploadOpen(true)}>
                  Upload SKU sheet
                </s-button>
              </div>
            </div>
          )}
          <div className="trends-footer">
            <span>{data.total.toLocaleString()} results</span>
            <div className="trends-pagination">
              <s-button
                disabled={data.page <= 1}
                href={queuePage(data, data.page - 1)}
              >
                Previous
              </s-button>
              <span>
                Page {data.page} of {data.pages}
              </span>
              <s-button
                disabled={data.page >= data.pages}
                href={queuePage(data, data.page + 1)}
              >
                Next
              </s-button>
            </div>
          </div>
        </div>
        {uploadOpen && (
          <Modal title="Upload SKU sheet" onClose={closeUpload}>
            <importer.Form method="post" encType="multipart/form-data">
              <input type="hidden" name="intent" value="import" />
              <div className="trends-upload-intro">
                <strong>Import your product codes</strong>
                <span>
                  We will validate the sheet and add only unique six-digit codes
                  to the current product list.
                </span>
              </div>
              <label
                className={`trends-upload${draggingFile ? " trends-upload--dragging" : ""}${uploadError ? " trends-upload--error" : ""}${file ? " trends-upload--ready" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (!importing) setDraggingFile(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setDraggingFile(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDraggingFile(false);
                  if (importing) return;
                  const droppedFile = event.dataTransfer.files?.[0] || null;
                  if (droppedFile && fileInputRef.current) {
                    const transfer = new DataTransfer();
                    transfer.items.add(droppedFile);
                    fileInputRef.current.files = transfer.files;
                  }
                  selectUploadFile(droppedFile);
                }}
              >
                <input
                  ref={fileInputRef}
                  className="trends-upload__input"
                  name="skuFile"
                  type="file"
                  accept=".xlsx,.csv,.txt"
                  required
                  disabled={importing}
                  onChange={(event) =>
                    selectUploadFile(event.target.files?.[0] || null)
                  }
                />
                {file ? (
                  <div className="trends-upload__selected">
                    <span className="trends-upload__file-icon">
                      {file.name.split(".").pop()?.toUpperCase()}
                    </span>
                    <div>
                      <strong>{file.name}</strong>
                      <span>
                        {(file.size / 1024).toFixed(1)} KB · Ready to import
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={importing}
                      onClick={(event) => {
                        event.preventDefault();
                        selectUploadFile(null);
                      }}
                      aria-label="Remove selected file"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div className="trends-upload__empty">
                    <span className="trends-upload__icon" aria-hidden="true">
                      ↑
                    </span>
                    <strong>
                      {draggingFile
                        ? "Drop your sheet here"
                        : "Drag and drop your sheet"}
                    </strong>
                    <span>
                      or <b>browse files</b> from your computer
                    </span>
                    <small>XLSX, CSV or TXT · Maximum 5 MB</small>
                  </div>
                )}
              </label>
              {uploadError && (
                <div className="trends-upload-message trends-upload-message--error">
                  <span>!</span>
                  {uploadError}
                </div>
              )}
              <div className="trends-upload-requirements">
                <div>
                  <span>1</span>
                  <p>
                    <strong>Required column</strong>The sheet must contain a
                    column named <code>code</code> or <code>sku</code>.
                  </p>
                </div>
                <div>
                  <span>2</span>
                  <p>
                    <strong>Additional columns</strong>Other values are
                    preserved and added as Shopify tags.
                  </p>
                </div>
                <div>
                  <span>3</span>
                  <p>
                    <strong>Existing SKUs</strong>Sheet values are updated while
                    the existing sync status and Shopify linkage are preserved.
                  </p>
                </div>
              </div>
              <div className="trends-modal-actions">
                <s-button onClick={closeUpload} disabled={importing}>
                  Cancel
                </s-button>
                <s-button
                  type="submit"
                  variant="primary"
                  loading={importing}
                  disabled={!file || importing}
                >
                  Import sheet
                </s-button>
              </div>
            </importer.Form>
          </Modal>
        )}
        {details && (
          <DetailsModal
            item={details}
            shop={data.shop}
            shippingProfile={data.shippingProfile}
            onClose={() => setDetails(null)}
          />
        )}
        {variantItem && (
          <ConfiguredVariantModal
            item={variantItem}
            fetcher={variantFetcher}
            onClose={() =>
              variantFetcher.state === "idle" && setVariantItem(null)
            }
          />
        )}
        {markupItem && (
          <Modal
            title={`Product settings for ${markupItem.productCode}`}
            onClose={() => !busy && setMarkupItem(null)}
          >
            <fetcher.Form
              method="post"
              className="trends-product-settings-form"
            >
              <input type="hidden" name="intent" value="markup" />
              <input type="hidden" name="id" value={markupItem.id} />
              <div className="trends-form-grid">
                <label className="trends-field">
                  Final total markup (%)
                  <input
                    className="trends-input"
                    name="individualMarkup"
                    type="number"
                    min="0"
                    max="1000"
                    step="0.01"
                    defaultValue={markupItem.individualMarkup ?? ""}
                    placeholder={`${data.globalMarkupPercent}% global`}
                  />
                  <small>
                    Leave blank to inherit the {data.globalMarkupPercent}%
                    global markup. This single markup is applied once to the
                    complete price total.
                  </small>
                </label>
              </div>
              <div className="trends-pricing-help">
                <div>
                  <strong>Review calculated selling prices</strong>
                  <span>
                    See how supplier prices, additions, setup fees, packaging,
                    shipping and the effective markup form the final price.
                  </span>
                </div>
                <button
                  type="button"
                  className="trends-pricing-link"
                  disabled={!markupItem.trendsDataJson}
                  onClick={() => setPriceItem(markupItem)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    aria-hidden="true"
                  >
                    <rect x="5" y="3" width="14" height="18" rx="2" />
                    <path d="M8 7h8M8 11h2m2 0h2m2 0h0M8 15h2m2 0h2m2 0h0M8 18h2m2 0h2m2 0h0" />
                  </svg>
                  <span>View price calculation</span>
                  <span aria-hidden="true">→</span>
                </button>
              </div>
              <label className="trends-field">
                <span>Gift-ready configuration</span>
                <span className="trends-checkbox-option">
                  <input
                    type="checkbox"
                    name="customCorporatePackEnabled"
                    defaultChecked={markupItem.customCorporatePackEnabled}
                  />
                  Offer Custom Corporate Pack for this product
                </span>
                <small>
                  Adds a selectable free packaging option to this product’s JSON
                  configuration. No unit or setup fee is charged.
                </small>
              </label>
              <div className="trends-modal-actions">
                <s-button onClick={() => setMarkupItem(null)} disabled={busy}>
                  Cancel
                </s-button>
                <s-button
                  type="submit"
                  variant="primary"
                  loading={
                    activeIntent === "markup" && fetcher.state !== "idle"
                  }
                  onClick={() => setActiveIntent("markup")}
                >
                  Save settings
                </s-button>
              </div>
            </fetcher.Form>
          </Modal>
        )}
        {priceItem && (
          <PriceCalculationModal
            item={priceItem}
            mainMarkup={priceItem.individualMarkup ?? data.globalMarkupPercent}
            markupSource={
              priceItem.individualMarkup == null ? "Global" : "Individual"
            }
            fixedShippingAmount={data.fixedShippingAmount}
            onClose={() => setPriceItem(null)}
          />
        )}
        {auditOpen && auditFetcher.data?.audit && (
          <SyncAuditModal
            audit={auditFetcher.data.audit}
            selected={auditSelected}
            busy={Boolean(progress)}
            onSelectedChange={setAuditSelected}
            onClose={() => !progress && setAuditOpen(false)}
            onSync={(requestedIds) => {
              const ids = [
                ...new Set(
                  (auditFetcher.data.audit?.issues || [])
                    .filter((item) => requestedIds.includes(item.id))
                    .flatMap((item) => item.rowIds || [item.id]),
                ),
              ];
              setAuditOpen(false);
              syncProducts(ids, true);
            }}
          />
        )}
        {confirm && (
          <ConfirmModal
            value={confirm}
            busy={fetcher.state !== "idle"}
            onCancel={() => !busy && setConfirm(null)}
            onConfirm={(intent) => {
              const resolvedIntent =
                typeof intent === "string" ? intent : confirm.type;
              if (["sync", "sync_all_info"].includes(resolvedIntent))
                syncProducts(confirm.ids);
              else submit(resolvedIntent, confirm.ids);
              setConfirm(null);
            }}
          />
        )}
        {fetcher.state !== "idle" && activeIntent === "sync" && (
          <div className="trends-action-loader">
            <span className="trends-spinner" />
            <div>
              <strong>Syncing products to Shopify</strong>
              <small>Creating products, variants, images and inventory…</small>
            </div>
          </div>
        )}
      </div>
    </s-page>
  );
}

function SyncAuditModal({
  audit,
  selected,
  busy,
  onSelectedChange,
  onClose,
  onSync,
}) {
  const repairable = audit.issues.filter((item) => item.canSync);
  const allSelected =
    repairable.length > 0 &&
    repairable.every((item) => selected.includes(item.id));
  return (
    <Modal title="Shopify sync health check" onClose={onClose} wide>
      <div className="trends-audit-summary">
        <div>
          <span>Products checked</span>
          <strong>{audit.checked}</strong>
        </div>
        <div>
          <span>Unique Shopify mains</span>
          <strong>{audit.mainProducts}</strong>
          {audit.duplicateMainProducts > 0 && (
            <small>{audit.duplicateMainProducts} duplicate record(s)</small>
          )}
        </div>
        <div className="is-healthy">
          <span>Active Shopify mains</span>
          <strong>{audit.activeMainProducts}</strong>
        </div>
        <div className={audit.issues.length ? "is-warning" : "is-healthy"}>
          <span>Needs attention</span>
          <strong>{audit.issues.length}</strong>
        </div>
      </div>
      {audit.issues.length ? (
        <>
          <s-banner tone="info" heading="Safe recovery mode">
            Products that were previously overwritten are recreated under their
            own TRENDS source code. Existing Shopify products are not deleted,
            and the store is checked again after the repair finishes.
          </s-banner>
          <div className="trends-audit-toolbar">
            <div className="trends-audit-select-all">
              <input
                type="checkbox"
                aria-label="Select all repairable products"
                checked={allSelected}
                onChange={(event) =>
                  onSelectedChange(
                    event.target.checked
                      ? repairable.map((item) => item.id)
                      : [],
                  )
                }
              />
              <span>
                <strong>Select all repairable products</strong>
                <small>
                  Missing or incorrectly linked Shopify products are selected
                  automatically.
                </small>
              </span>
            </div>
            <s-badge tone="warning">{selected.length} selected</s-badge>
          </div>
          <div className="trends-audit-list">
            {audit.issues.map((item) => (
              <label
                key={item.id}
                className={`trends-audit-item${item.canSync ? "" : " is-disabled"}`}
              >
                <input
                  type="checkbox"
                  disabled={!item.canSync || busy}
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    onSelectedChange((current) =>
                      event.target.checked
                        ? [...new Set([...current, item.id])]
                        : current.filter((id) => id !== item.id),
                    )
                  }
                />
                <span className="trends-audit-item__code">
                  SKU {item.productCode}
                </span>
                <span className="trends-audit-item__copy">
                  <strong>{item.title}</strong>
                  <small>{item.reason}</small>
                </span>
                <s-badge tone={item.canSync ? "critical" : "info"}>
                  {item.actionLabel ||
                    (item.canSync ? "Repair available" : "Fetch required")}
                </s-badge>
              </label>
            ))}
          </div>
          <div className="trends-modal-actions">
            <s-button onClick={onClose} disabled={busy}>
              Close
            </s-button>
            {selected.length !== repairable.length && (
              <s-button
                icon="refresh"
                disabled={!selected.length || busy}
                onClick={() => onSync(selected)}
              >
                Fix selected ({selected.length})
              </s-button>
            )}
            <s-button
              variant="primary"
              icon="refresh"
              disabled={!repairable.length || busy}
              onClick={() => onSync(repairable.map((item) => item.id))}
            >
              Fix all detected issues ({repairable.length})
            </s-button>
          </div>
        </>
      ) : (
        <div className="trends-audit-empty">
          <span aria-hidden="true">✓</span>
          <strong>Everything is in sync</strong>
          <p>
            Every fetched TRENDS item has a correctly linked main product,
            configured master product and valid configuration in Shopify.
          </p>
          <div className="trends-modal-actions">
            <s-button variant="primary" onClick={onClose}>
              Done
            </s-button>
          </div>
        </div>
      )}
    </Modal>
  );
}
function QueueMetric({ label, value, tone = "" }) {
  return (
    <div className="trends-metric">
      <div className="trends-metric__top">
        <span>{label}</span>
        <span
          className={`trends-metric__dot${tone ? ` trends-metric__dot--${tone}` : ""}`}
        />
      </div>
      <strong>{Number(value).toLocaleString()}</strong>
    </div>
  );
}
const renderUpdatedAt = (value) => {
  if (!value) return <span className="trends-updated-cell__empty">—</span>;
  const updatedAt = new Date(value);
  return (
    <span className="trends-updated-cell__value">
      <strong>{updatedAt.toLocaleDateString()}</strong>
      <span>
        {updatedAt.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })}
      </span>
    </span>
  );
};

function StatusBadge({ status }) {
  const tone =
    status === "SYNCED"
      ? "success"
      : status === "QUOTE_ONLY"
        ? "info"
        : status === "FETCHED"
          ? "info"
          : status === "FAILED"
            ? "critical"
            : status === "FETCHING"
              ? "info"
              : "warning";
  return (
    <s-badge tone={tone}>{status.toLowerCase().replace("_", " ")}</s-badge>
  );
}
function ProgressPanel({ progress }) {
  const percent = Math.round((progress.current / progress.total) * 100);
  return (
    <div className="trends-import-progress">
      <div className="trends-import-progress__head">
        <div className="trends-import-progress__title">
          {percent < 100 && <span className="trends-spinner" />}
          {progress.label}
        </div>
        <s-badge
          tone={
            percent === 100 ? (progress.failed ? "warning" : "success") : "info"
          }
        >
          {progress.current} / {progress.total}
        </s-badge>
      </div>
      <div className="trends-progress-track">
        <span
          className="trends-progress-bar"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="trends-progress-meta">
        <span>
          {percent === 100
            ? `${progress.label.startsWith("Syncing") ? "Sync" : "Fetch"} completed${progress.failed ? ` · ${progress.failed} failed` : ""}`
            : progress.label.startsWith("Syncing")
              ? "Updating products in Shopify one at a time"
              : "Loading titles, images, variants and pricing"}
        </span>
        <span>{percent}%</span>
      </div>
    </div>
  );
}
function ConfiguredVariantModal({ item, fetcher, onClose }) {
  const [enabled, setEnabled] = useState(
    Boolean(item.configuredVariantEnabled),
  );
  const [options, setOptions] = useState(item.configuredVariant?.options || []);
  const [primaryOptionKey, setPrimaryOptionKey] = useState(
    item.configuredVariant?.primaryOptionKey ||
      item.configuredVariant?.options?.[0]?.key ||
      "",
  );
  const [newOptionName, setNewOptionName] = useState("");
  const [newOptionValues, setNewOptionValues] = useState("");
  const [expandedOptions, setExpandedOptions] = useState(() => new Set());
  const [showMapping, setShowMapping] = useState(false);
  const busy = fetcher.state !== "idle";
  let supplierVariants = [];
  try {
    const supplier = JSON.parse(item.trendsDataJson || "{}");
    supplierVariants = (Array.isArray(supplier.stock) ? supplier.stock : [])
      .map((row) => ({
        sku: String(row?.sku || row?.stock_code || row?.code || "").trim(),
        name: String(row?.description || row?.name || "").trim(),
      }))
      .filter((row) => row.sku);
  } catch {
    supplierVariants = [];
  }
  const configurationPayload = {
    enabled,
    primaryOptionKey,
    options: options.map((option) => ({
      key: option.key,
      name: option.name,
      displayValues: option.displayValues || {},
      values: option.values || [],
      manual: option.manual === true,
      source: option.source || "normal",
      matches: option.matches || [],
    })),
    aiSuggestion: item.configuredVariant?.aiSuggestion,
  };
  return (
    <Modal
      title={`Configured variants · ${item.productCode}`}
      onClose={onClose}
      wide
    >
      <fetcher.Form method="post" className="trends-variant-editor">
        <input type="hidden" name="intent" value="configured_variant" />
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="enabled" value={String(enabled)} />
        <input
          type="hidden"
          name="configuration"
          value={JSON.stringify(configurationPayload)}
        />
        <label
          className="trends-variant-visibility trends-variant-visibility--primary"
          aria-label="Show configured variants on the storefront"
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            <strong>Show configured variants on the storefront</strong>
            <small>
              The selector is displayed only when this option is enabled.
            </small>
          </span>
        </label>
        <section className="trends-ai-suggestion-card trends-ai-help-card">
          <div>
            <span className="trends-source-badge is-ai">AI Help</span>
            <strong>Find missing variant fields</strong>
            <small>
              Built-in detection runs first. AI then reviews this product’s
              complete unbranded variant data and suggests only fields that are
              still missing. Suggestions are never applied automatically.
            </small>
          </div>
          <button
            type="button"
            className="trends-secondary-button"
            disabled={busy}
            onClick={() =>
              fetcher.submit(
                { intent: "generate_ai_variant_suggestion", id: item.id },
                { method: "post" },
              )
            }
          >
            {busy ? "AI analysing…" : "Ask AI for help"}
          </button>
        </section>
        {item.configuredVariant?.aiSuggestion?.options?.length > 0 && (
          <section className="trends-ai-suggestion-card">
            <div>
              <span className="trends-source-badge is-ai">AI suggested</span>
              <strong>Review suggested option types</strong>
              <small>
                Generated only from unbranded supplier SKU names. Nothing is
                published until you approve it.
              </small>
            </div>
            <div className="trends-ai-suggestion-options">
              {item.configuredVariant.aiSuggestion.options.map((option) => (
                <span key={option.key}>
                  <b>
                    {option.name}{" "}
                    <em className="trends-source-badge is-ai">AI</em>
                  </b>
                  <small>
                    {option.values.length} values ·{" "}
                    {Math.round((option.confidence || 0) * 100)}% confidence
                  </small>
                  <small>
                    SKUs: {option.matches.map((match) => match.sku).join(", ")}
                  </small>
                </span>
              ))}
            </div>
            {item.configuredVariant.aiSuggestion.status !== "approved" && (
              <button
                type="button"
                className="trends-primary-button"
                disabled={busy}
                onClick={() =>
                  fetcher.submit(
                    { intent: "accept_ai_variant_suggestion", id: item.id },
                    { method: "post" },
                  )
                }
              >
                {busy ? "Approving…" : "Approve AI suggestions"}
              </button>
            )}
          </section>
        )}
        <section className="trends-variant-section trends-variant-section--preview">
          <div className="trends-variant-section__heading">
            <span className="trends-section-number">1</span>
            <div>
              <strong>Storefront preview</strong>
              <small>This is how customers will choose a variant.</small>
            </div>
            <span className={enabled ? "is-live" : "is-draft"}>
              {enabled ? "Visible" : "Draft"}
            </span>
          </div>
          <div className="trends-storefront-preview trends-storefront-preview--primary">
            {options.length ? (
              options.map((option) => (
                <div className="trends-storefront-option" key={option.key}>
                  <b>{option.name}</b>
                  <div>
                    {(option.values || []).map((value) => (
                      <button type="button" key={value}>
                        {option.displayValues?.[value] || value}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="trends-variant-preview-empty">
                No options detected yet. Add a custom option below to begin.
              </div>
            )}
          </div>
        </section>
        <section className="trends-variant-section">
          <div className="trends-variant-section__heading">
            <span className="trends-section-number">2</span>
            <div>
              <strong>Primary option</strong>
              <small>
                Choose the first option customers will interact with.
              </small>
            </div>
          </div>
          <div className="trends-variant-editor-summary">
            <span className={enabled ? "is-configured" : "is-draft"}>
              {enabled ? "Configured and visible" : "Configuration draft"}
            </span>
            <label className="trends-field">
              Main customer option
              <select
                className="trends-input"
                value={primaryOptionKey}
                onChange={(event) => setPrimaryOptionKey(event.target.value)}
              >
                {options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
        <section className="trends-variant-section">
          <div className="trends-variant-section__heading">
            <span className="trends-section-number">3</span>
            <div>
              <strong>Option configuration</strong>
              <small>
                Edit labels only when the detected values need adjustment.
              </small>
            </div>
            <span className="trends-count-badge">{options.length}</span>
          </div>
          <div className="trends-variant-option-list">
            {options.map((option, index) => {
              const isExpanded = expandedOptions.has(option.key);
              return (
                <section
                  className={`trends-variant-group trends-variant-group--accordion${isExpanded ? " is-open" : ""}`}
                  key={option.key || index}
                >
                  <header className="trends-variant-group__header">
                    <span className="trends-variant-step">{index + 1}</span>
                    <div>
                      <strong>{option.name}</strong>
                      <span
                        className={`trends-source-badge ${option.source === "ai" ? "is-ai" : "is-normal"}`}
                      >
                        {option.source === "ai" ? "AI" : "Normal"}
                      </span>
                      <small>
                        {option.values?.length || 0} values ·{" "}
                        {option.matches?.length || 0} linked variants
                      </small>
                    </div>
                    <button
                      type="button"
                      className="trends-option-toggle"
                      onClick={() =>
                        setExpandedOptions((current) => {
                          const next = new Set(current);
                          if (next.has(option.key)) next.delete(option.key);
                          else next.add(option.key);
                          return next;
                        })
                      }
                    >
                      {isExpanded ? "Done" : "Edit labels"}
                    </button>
                    {option.manual && (
                      <button
                        type="button"
                        className="trends-option-remove"
                        onClick={() => {
                          setOptions((current) =>
                            current.filter((_, rowIndex) => rowIndex !== index),
                          );
                          if (primaryOptionKey === option.key)
                            setPrimaryOptionKey(
                              options.find((_, rowIndex) => rowIndex !== index)
                                ?.key || "",
                            );
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </header>
                  {isExpanded && (
                    <div className="trends-variant-group__content">
                      <label className="trends-option-label-field">
                        <span>Customer-facing label</span>
                        <input
                          className="trends-input"
                          value={option.name}
                          onChange={(event) =>
                            setOptions((current) =>
                              current.map((row, rowIndex) =>
                                rowIndex === index
                                  ? { ...row, name: event.target.value }
                                  : row,
                              ),
                            )
                          }
                        />
                      </label>
                      <div className="trends-variant-value-cards">
                        {(option.values || []).map((value) => {
                          const linked = (option.matches || []).filter(
                            (match) => match.value === value,
                          );
                          return (
                            <article
                              className="trends-variant-value-card"
                              key={value}
                            >
                              <div className="trends-variant-value-card__top">
                                <div>
                                  <span>Detected value</span>
                                  <strong>{value}</strong>
                                </div>
                                <label>
                                  Customer sees
                                  <input
                                    className="trends-input"
                                    value={
                                      option.displayValues?.[value] ?? value
                                    }
                                    onChange={(event) =>
                                      setOptions((current) =>
                                        current.map((row, rowIndex) =>
                                          rowIndex === index
                                            ? {
                                                ...row,
                                                displayValues: {
                                                  ...(row.displayValues || {}),
                                                  [value]: event.target.value,
                                                },
                                              }
                                            : row,
                                        ),
                                      )
                                    }
                                  />
                                </label>
                              </div>
                              <div className="trends-linked-variants">
                                <span>
                                  {linked.length} linked variant
                                  {linked.length === 1 ? "" : "s"}
                                </span>
                                <div>
                                  {linked.slice(0, 12).map((match) => (
                                    <code key={`${value}-${match.sku}`}>
                                      {match.sku}
                                    </code>
                                  ))}
                                  {linked.length > 12 && (
                                    <code>+{linked.length - 12}</code>
                                  )}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                      {option.manual && supplierVariants.length > 0 && (
                        <div className="trends-manual-mapping">
                          <div className="trends-manual-mapping__header">
                            <div>
                              <strong>Assign supplier SKUs</strong>
                              <small>
                                Choose the correct {option.name.toLowerCase()}{" "}
                                value for each variant.
                              </small>
                            </div>
                            <span>{supplierVariants.length} SKUs</span>
                          </div>
                          <div className="trends-manual-mapping__rows">
                            {supplierVariants.map((variant) => {
                              const selectedValue =
                                option.matches?.find(
                                  (match) => match.sku === variant.sku,
                                )?.value || "";
                              return (
                                <label key={`${option.key}-${variant.sku}`}>
                                  <span>
                                    <strong>{variant.sku}</strong>
                                    <small>
                                      {variant.name || "Supplier variant"}
                                    </small>
                                  </span>
                                  <select
                                    className="trends-input"
                                    value={selectedValue}
                                    onChange={(event) =>
                                      setOptions((current) =>
                                        current.map((row, rowIndex) => {
                                          if (rowIndex !== index) return row;
                                          const remaining = (
                                            row.matches || []
                                          ).filter(
                                            (match) =>
                                              match.sku !== variant.sku,
                                          );
                                          return {
                                            ...row,
                                            matches: event.target.value
                                              ? [
                                                  ...remaining,
                                                  {
                                                    sku: variant.sku,
                                                    value: event.target.value,
                                                  },
                                                ]
                                              : remaining,
                                          };
                                        }),
                                      )
                                    }
                                  >
                                    <option value="">Not assigned</option>
                                    {(option.values || []).map((value) => (
                                      <option key={value} value={value}>
                                        {value}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <div className="trends-product-option-add">
            <div>
              <strong>Add product-specific option</strong>
              <small>
                Use this when this product has an additional option not covered
                by global settings.
              </small>
            </div>
            <input
              className="trends-input"
              value={newOptionName}
              onChange={(event) => setNewOptionName(event.target.value)}
              placeholder="Option name"
            />
            <input
              className="trends-input"
              value={newOptionValues}
              onChange={(event) => setNewOptionValues(event.target.value)}
              placeholder="Values, comma separated"
            />
            <button
              type="button"
              onClick={() => {
                const name = newOptionName.trim();
                const values = newOptionValues
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean);
                if (!name || values.length < 2) return;
                const key = `manual_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
                setOptions((current) => [
                  ...current.filter((option) => option.key !== key),
                  {
                    key,
                    name,
                    values,
                    displayValues: Object.fromEntries(
                      values.map((value) => [value, value]),
                    ),
                    matches: [],
                    manual: true,
                  },
                ]);
                setPrimaryOptionKey((current) => current || key);
                setNewOptionName("");
                setNewOptionValues("");
              }}
            >
              Add option
            </button>
          </div>
        </section>
        <section className="trends-variant-section trends-variant-section--mapping">
          <button
            type="button"
            className="trends-mapping-toggle"
            onClick={() => setShowMapping((value) => !value)}
          >
            <span className="trends-section-number">4</span>
            <span>
              <strong>Supplier SKU mapping</strong>
              <small>
                Review which option values are connected to each variant.
              </small>
            </span>
            <b>{showMapping ? "Hide details" : "Review mapping"}</b>
          </button>
          {showMapping && (
            <div className="trends-variant-preview-grid">
              {(item.configuredVariant?.variants || [])
                .slice(0, 100)
                .map((variant) => (
                  <div key={`${variant.sku}-${variant.fullName}`}>
                    <span>SKU {variant.sku || "—"}</span>
                    <strong>{variant.fullName || "Unnamed variant"}</strong>
                    <small>
                      {Object.entries(variant.attributes || {})
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(" · ") || "No mapped value"}
                    </small>
                  </div>
                ))}
            </div>
          )}
        </section>
        <div className="trends-modal-actions">
          <s-button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </s-button>
          <s-button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={busy}
          >
            Save configuration
          </s-button>
        </div>
      </fetcher.Form>
    </Modal>
  );
}

function Modal({ title, onClose, children, compact = false, wide = false }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="trends-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`trends-modal${compact ? " trends-modal--compact" : ""}${wide ? " trends-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="trends-modal-header">
          <div>
            <p className="trends-eyebrow">Product operations</p>
            <h2>{title}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="trends-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
function ConfirmModal({ value, busy, onCancel, onConfirm }) {
  return (
    <Modal title={value.title} onClose={onCancel} compact>
      <p className="trends-confirm-copy">{value.body}</p>
      <div className="trends-modal-actions">
        <s-button onClick={onCancel} disabled={busy}>
          Cancel
        </s-button>
        {value.type === "remove" ? (
          <>
            <s-button
              variant="primary"
              tone="critical"
              loading={busy}
              onClick={() => onConfirm("remove")}
            >
              Delete from Shopify + list
            </s-button>
            <s-button
              tone="critical"
              loading={busy}
              onClick={() => onConfirm("remove_shopify")}
            >
              Delete from Shopify only
            </s-button>
          </>
        ) : (
          <s-button
            variant="primary"
            loading={busy}
            onClick={() => onConfirm(value.type)}
          >
            {value.type === "publish_online_store"
              ? "Confirm publish"
              : value.type === "sync_all_info"
                ? "Yes, sync all products"
                : "Confirm sync"}
          </s-button>
        )}
      </div>
    </Modal>
  );
}

function PriceCalculationModal({
  item,
  mainMarkup,
  markupSource,
  fixedShippingAmount,
  onClose,
}) {
  const product = safeJson(item.trendsDataJson);
  const prices = product.pricing?.[0]?.prices || [];
  const costs = uniqueAdditionalCosts(product);
  return (
    <Modal title={`Price calculation · ${item.productCode}`} onClose={onClose}>
      <div className="trends-pricing-source">
        <s-badge tone={markupSource === "Individual" ? "success" : "info"}>
          {markupSource} markup
        </s-badge>
        <span>
          {markupSource === "Individual"
            ? "This product uses its own markup override."
            : "This product inherits the global markup from Settings."}
        </span>
      </div>
      <div className="trends-price-summary">
        <Detail label="Effective markup" value={`${mainMarkup}%`} />
        <Detail label="Fixed shipping" value={money(fixedShippingAmount)} />
        <Detail label="Currency" value="NZD" />
      </div>
      <DetailSection title="Unbranded product pricing">
        <p className="trends-detail-note">
          Final price = (supplier total + selected additions + setup + gift
          packaging + fixed shipping) × (1 + markup ÷ 100)
        </p>
        <SimpleTable
          headers={[
            "Quantity",
            "Supplier price",
            "Final total",
            "Final unit price",
          ]}
          rows={prices.map((price) => [
            price.quantity,
            money(price.price),
            money(
              (Number(price.price || 0) * Number(price.quantity || 1) +
                Number(fixedShippingAmount || 0)) *
                (1 + Number(mainMarkup || 0) / 100),
            ),
            money(
              ((Number(price.price || 0) * Number(price.quantity || 1) +
                Number(fixedShippingAmount || 0)) *
                (1 + Number(mainMarkup || 0) / 100)) /
                Math.max(1, Number(price.quantity || 1)),
            ),
          ])}
        />
      </DetailSection>
      <DetailSection title="Raw additional costs">
        <p className="trends-detail-note">
          These supplier costs remain raw. The live storefront API combines the
          selected costs with fixed shipping, then applies the final markup
          once.
        </p>
        <SimpleTable
          headers={["Branding variant", "Supplier unit", "Supplier setup"]}
          rows={costs.map((cost) => [
            cost.branding_option || cost.description || "Branding",
            money(cost.unit_price),
            money(cost.setup_price ?? cost.setup),
          ])}
        />
      </DetailSection>
    </Modal>
  );
}

function ProductRelationshipSection({ item, product, shop }) {
  const costs = uniqueAdditionalCosts(product);
  const isSynced = item.status === "SYNCED" && item.shopifyProductId;
  const storefrontUrl = storefrontUrlFor(item, shop);
  return (
    <DetailSection title="Shopify product structure">
      <div className="trends-detail-note">
        <strong>{isSynced ? "Connected to Shopify" : "Not synced yet"}</strong>
        <span>
          {isSynced
            ? " The unbranded product contains all pricing and branding options in one JSON metafield."
            : " Sync this product to create the Shopify product and its JSON configuration."}
        </span>
      </div>
      <div className="trends-relation-flow">
        <div className="trends-relation-node">
          <span>Unbranded Shopify product</span>
          <strong>{product.name || item.title || item.productCode}</strong>
          {item.shopifyProductId ? (
            <>
              <small>
                Product ID: {String(item.shopifyProductId).split("/").pop()}
              </small>
              <a
                className="trends-admin-product-link"
                href={shopifyAdminProductUrl(shop, item.shopifyProductId)}
                target="_blank"
                rel="noreferrer"
              >
                Open unbranded product in Shopify Admin ↗
              </a>
              {storefrontUrl && (
                <a
                  className="trends-admin-product-link"
                  href={storefrontUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View unbranded product on storefront ↗
                </a>
              )}
            </>
          ) : (
            <em className="trends-relation-status">Not synced</em>
          )}
        </div>
        <div className="trends-relation-arrow">
          <span>Branding configuration</span>
          <strong>trends.product_configuration</strong>
        </div>
        <div className="trends-relation-node">
          <span>Branding &amp; configured-order product</span>
          <strong>
            {item.masterShopifyProduct?.title ||
              product.name ||
              item.title ||
              item.productCode}
          </strong>
          {item.shopifyMasterProductId ? (
            <>
              <small>
                Product ID:{" "}
                {String(item.shopifyMasterProductId).split("/").pop()}
              </small>
              <a
                className="trends-admin-product-link"
                href={shopifyAdminProductUrl(shop, item.shopifyMasterProductId)}
                target="_blank"
                rel="noreferrer"
              >
                Open branding product in Shopify Admin ↗
              </a>
              <em className="trends-relation-status">
                Hidden configured variants used for cart orders
              </em>
            </>
          ) : (
            <em className="trends-relation-status">Not created yet</em>
          )}
        </div>
      </div>
      {costs.length ? (
        <DetailSection title={`Branding options in JSON (${costs.length})`}>
          <SimpleTable
            headers={["Method", "Unit charge code", "Setup charge code"]}
            rows={costs.map((cost) => [
              cost.branding_option || cost.description || "Branding",
              (cost.price_per_unit_charge_codes || [])
                .map((code) => code.price_per_unit_charge_code)
                .filter(Boolean)
                .join(", ") || "—",
              Number(cost.setup_price ?? cost.setup ?? 0) > 0
                ? `TRENDS-${product.code}-SETUP-${cost.id}`
                : "Not required",
            ])}
          />
        </DetailSection>
      ) : (
        <div className="trends-dashboard-empty">
          <p>This TRENDS product has no additional branding options.</p>
        </div>
      )}
      <details className="trends-raw-details">
        <summary>JSON metafield details</summary>
        <pre>
          {JSON.stringify(
            {
              metafield: {
                namespace: "trends",
                key: "product_configuration",
                type: "json",
              },
              branding_options: costs.length,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </DetailSection>
  );
}

const safeJson = (value) => {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
};
const uniqueAdditionalCosts = (product) => [
  ...new Map(
    (product.pricing?.flatMap((tier) => tier.additional_costs || []) || []).map(
      (cost, index) => [
        String(cost.id ?? `${cost.description}-${index}`),
        cost,
      ],
    ),
  ).values(),
];
const money = (value) =>
  `$${Number(value || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shopifyAdminProductUrl = (shop, productId) =>
  `https://${shop}/admin/products/${encodeURIComponent(String(productId).split("/").pop())}`;

function DetailsModal({ item, shop, shippingProfile, onClose }) {
  let p = {};
  try {
    p = JSON.parse(item.trendsDataJson || "{}");
  } catch {
    p = {};
  }
  const pricing = p.pricing || [];
  const costs = [
    ...new Map(
      pricing
        .flatMap((tier) => tier.additional_costs || [])
        .map((cost, index) => [
          String(cost.id ?? `${cost.description}-${index}`),
          cost,
        ]),
    ).values(),
  ];
  return (
    <Modal title={p.name || item.productCode} onClose={onClose} wide>
      <div className="trends-details-content">
        <div className="trends-detail-hero">
          {item.imageUrl && <img src={item.imageUrl} alt="" />}
          <div>
            <span className="trends-code">{item.productCode}</span>
            <p>
              {p.description || p.short_description || "TRENDS product details"}
            </p>
          </div>
        </div>
        <div className="trends-detail-grid">
          <Detail label="Parent code" value={p.code} />
          <Detail label="Source file" value={item.sourceFile || "—"} />
          <Detail label="Source row" value={item.rowNumber || "—"} />
          <Detail
            label="Status"
            value={`${p.active || "—"} · ${p.status || "—"}`}
          />
          <Detail label="Colours" value={p.colours} />
          <Detail label="Variants" value={p.stock?.length || 0} />
          <Detail label="Images" value={p.images?.length || 0} />
          <Detail label="Packaging" value={p.packaging} />
          <Detail label="Last updated" value={p.last_updated} />
          <Detail
            label="Product wire"
            value={p.product_wire ? "Available" : "—"}
          />
          <Detail
            label="Shipping profile"
            value={
              shippingProfile
                ? `${shippingProfile.name}${item.status === "SYNCED" ? " · Assigned" : " · Selected for sync"}`
                : "Shopify general profile"
            }
          />
        </div>
        <ProductRelationshipSection item={item} product={p} shop={shop} />
        {!!p.features?.length && (
          <DetailSection title="Features">
            <ul className="trends-detail-list">
              {p.features.map((feature, index) => (
                <li key={`${feature}${index}`}>{feature}</li>
              ))}
            </ul>
          </DetailSection>
        )}
        {!!p.images?.length && (
          <DetailSection title="Product images">
            <div className="trends-image-grid">
              {p.images.map((image, index) => (
                <a
                  key={`${image.link}${index}`}
                  href={normalizeTrendsUrl(image.link)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={normalizeTrendsUrl(image.link)}
                    alt={image.caption || image.colour || p.name || "Product"}
                  />
                  <span>
                    {image.caption || image.colour || `Image ${index + 1}`}
                  </span>
                </a>
              ))}
            </div>
          </DetailSection>
        )}
        <DetailSection title="Stock and variants">
          <div className="trends-table-wrap">
            <table className="trends-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Colour</th>
                  <th>Stock</th>
                  <th>Next shipment</th>
                  <th>Due date</th>
                </tr>
              </thead>
              <tbody>
                {(p.stock || []).slice(0, 50).map((v, i) => (
                  <tr key={`${v.stock_code}${i}`}>
                    <td>
                      <span className="trends-code">{v.stock_code || "—"}</span>
                    </td>
                    <td>{v.description || v.colour || v.color || "—"}</td>
                    <td>{v.quantity ?? "—"}</td>
                    <td>{v.next_shipment ?? "—"}</td>
                    <td>{v.due_date || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
        {pricing.map((tier, tierIndex) => (
          <DetailSection
            key={`${tier.type}${tierIndex}`}
            title={`${tier.primary_price_description || tier.type || "Product"} pricing`}
          >
            <div className="trends-table-wrap">
              <table className="trends-table">
                <thead>
                  <tr>
                    <th>Quantity</th>
                    <th>Supplier price</th>
                    <th>Less than MOQ</th>
                  </tr>
                </thead>
                <tbody>
                  {(tier.prices || []).map((price, index) => (
                    <tr key={`${price.quantity}${index}`}>
                      <td>{price.quantity}</td>
                      <td>${Number(price.price || 0).toFixed(2)}</td>
                      <td>{tier.less_than_moq || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tier.pricing_comment && (
              <p className="trends-detail-note">{tier.pricing_comment}</p>
            )}
          </DetailSection>
        ))}
        {!!costs.length && (
          <DetailSection title={`Additional costs (${costs.length})`}>
            <p className="trends-detail-note">
              These entries are stored in the unbranded Shopify product's JSON
              configuration metafield with their unit price, setup price and
              charge codes.
            </p>
            <div className="trends-table-wrap">
              <table className="trends-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Branding</th>
                    <th>Area</th>
                    <th>Unit</th>
                    <th>Setup</th>
                    <th>Unit SKU(s)</th>
                    <th>Order SKU</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.map((cost, index) => (
                    <tr key={`${cost.id}${index}`}>
                      <td>{cost.description || "—"}</td>
                      <td>{cost.branding_option || "—"}</td>
                      <td>{cost.branding_area || "—"}</td>
                      <td>${Number(cost.unit_price || 0).toFixed(2)}</td>
                      <td>
                        $
                        {Number(cost.setup_price ?? cost.setup ?? 0).toFixed(2)}
                      </td>
                      <td>
                        {(cost.price_per_unit_charge_codes || [])
                          .map((code) => code.price_per_unit_charge_code)
                          .join(", ") || "—"}
                      </td>
                      <td>{cost.price_per_order_charge_code || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DetailSection>
        )}
        {!!p.branding_options?.length && (
          <DetailSection title="Branding options">
            <SimpleTable
              headers={["Print type", "Description"]}
              rows={p.branding_options.map((option) => [
                option.print_type,
                option.print_description,
              ])}
            />
          </DetailSection>
        )}
        {!!p.additional_specifications?.length && (
          <DetailSection title="Specifications">
            <SimpleTable
              headers={["Specification", "Description"]}
              rows={p.additional_specifications.map((spec) => [
                spec.specification,
                spec.description,
              ])}
            />
          </DetailSection>
        )}
        {!!p.additional_materials?.length && (
          <DetailSection title="Materials">
            <SimpleTable
              headers={["Component", "Material"]}
              rows={p.additional_materials.map((material) => [
                material.component,
                material.material,
              ])}
            />
          </DetailSection>
        )}
        {!!p.categories?.length && (
          <DetailSection title="Categories">
            <SimpleTable
              headers={["Category", "Parent", "Number"]}
              rows={p.categories.map((category) => [
                category.name,
                category.appa_parent || "—",
                category.num,
              ])}
            />
          </DetailSection>
        )}
        <DetailSection title="Logistics and dimensions">
          <div className="trends-detail-grid">
            <Detail
              label="Dimensions"
              value={(p.dimensions || []).join(", ")}
            />
            <Detail label="Sizing" value={(p.sizing || []).join(", ")} />
            <Detail
              label="Carton size"
              value={
                p.carton
                  ? `${p.carton.length} × ${p.carton.width} × ${p.carton.height}`
                  : "—"
              }
            />
            <Detail label="Carton weight" value={p.carton?.weight} />
            <Detail label="Carton quantity" value={p.carton?.quantity} />
            <Detail label="Standard colours" value={p.standard_colours} />
          </div>
        </DetailSection>
        <details className="trends-raw-details">
          <summary>Complete raw TRENDS data</summary>
          <pre>{JSON.stringify(p, null, 2)}</pre>
        </details>
      </div>
    </Modal>
  );
}
function DetailSection({ title, children }) {
  return (
    <section className="trends-detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function SimpleTable({ headers, rows }) {
  return (
    <div className="trends-table-wrap">
      <table className="trends-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, column) => (
                <td key={column}>{value || "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Detail({ label, value }) {
  return (
    <div className="trends-help">
      <strong>{label}</strong>
      {value || "—"}
    </div>
  );
}
const queuePage = (data, page) =>
  `/app/products?${new URLSearchParams({ ...(data.search ? { q: data.search } : {}), ...(data.status ? { status: data.status } : {}), sort: data.sort || "first", page: String(Math.max(1, page)) })}`;
export const headers = (args) => boundary.headers(args);
