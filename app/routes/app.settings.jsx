import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Form,
  Link,
  useFetcher,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { TrendsClient } from "../lib/trends.server";
import { encryptSecret, decryptSecret } from "../lib/crypto.server";
import { classifyProductVariantsWithAi } from "../lib/ai-variant-classifier.server";
import {
  applyProductTemplateAndSalesChannels,
  assignProductsToShippingProfile,
  getProductTemplates,
  getSalesChannels,
  getShippingConfiguration,
  getPrimaryLocation,
  syncTrendsPriceAndInventory,
  ensureTrendsMetafieldDefinitions,
  setConfiguredVariantMetafield,
} from "../lib/shopify-sync.server";
import {
  DEFAULT_VARIANT_TYPES,
  parseVariantTypes,
  summarizeVariantMatches,
  buildConfiguredVariant,
} from "../lib/variant-configuration";
import { normalizeEmailRecipients } from "../lib/email-recipients";

const parseIds = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const safeJsonArray = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const settingLabel = {
  trendsBaseUrl: "TRENDS API URL",
  encryptedTrendsToken: "TRENDS bearer token",
  globalMarkupPercent: "Final total markup",
  fixedShippingAmount: "Fixed shipping amount",
  quoteNotificationEmail: "Quote notification email",
  inventoryLocationId: "Inventory location",
  productTemplateSuffix: "Product template",
  shippingProfileId: "Shipping profile",
  selectedPublicationIdsJson: "Sales channels",
};

const describeSettingChanges = (before, after, tokenChanged) =>
  Object.keys(settingLabel)
    .filter((key) => {
      if (key === "encryptedTrendsToken") return tokenChanged;
      if (key === "selectedPublicationIdsJson") {
        return (
          JSON.stringify([...safeJsonArray(before[key])].sort()) !==
          JSON.stringify([...safeJsonArray(after[key])].sort())
        );
      }
      return (before[key] ?? null) !== (after[key] ?? null);
    })
    .map((key) => settingLabel[key]);

const settingsFormSignature = (form) => {
  if (!form) return "";
  return JSON.stringify(
    [...new FormData(form).entries()]
      .filter(
        ([name]) => !["intent", "trendsToken", "tokenChanged"].includes(name),
      )
      .map(([name, value]) => [name, String(value)])
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
        `${leftName}:${leftValue}`.localeCompare(`${rightName}:${rightValue}`),
      ),
  );
};

const releaseStaleSettingsJobs = (shop) =>
  prisma.cronSyncLog.updateMany({
    where: {
      shop,
      mode: "settings",
      status: "RUNNING",
      startedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
    },
    data: {
      status: "INTERRUPTED",
      errorsJson: JSON.stringify([
        { message: "The settings update stopped reporting progress." },
      ]),
      finishedAt: new Date(),
    },
  });

const loadStorefrontProductLinks = async (admin, products, shop) => {
  const ids = [
    ...new Set(products.map((item) => item.shopifyProductId).filter(Boolean)),
  ];
  if (!ids.length) return new Map();
  const links = new Map();
  try {
    for (let index = 0; index < ids.length; index += 100) {
      const response = await admin.graphql(
        `#graphql
          query VariantSettingsStorefrontLinks($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product { id handle onlineStoreUrl }
            }
          }
        `,
        { variables: { ids: ids.slice(index, index + 100) } },
      );
      const json = await response.json();
      for (const product of (json.data?.nodes || []).filter(Boolean)) {
        links.set(
          product.id,
          product.onlineStoreUrl ||
            (product.handle
              ? `https://${shop}/products/${encodeURIComponent(product.handle)}`
              : null),
        );
      }
    }
    return links;
  } catch {
    return links;
  }
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const initialTab =
    url.searchParams.get("tab") === "variants" ? "variants" : "general";
  await releaseStaleSettingsJobs(session.shop);
  const settings = await prisma.shopSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop },
    update: {},
  });
  const [
    response,
    salesChannelResult,
    templateResult,
    shippingProfileResult,
    mainOverrideCount,
    variantProducts,
  ] = await Promise.all([
    admin.graphql(`#graphql
        query SyncLocations {
          locations(first: 50, includeInactive: false) {
            nodes { id name }
          }
        }
      `),
    getSalesChannels(admin)
      .then((salesChannels) => ({ salesChannels, warning: "" }))
      .catch((error) => ({
        salesChannels: [],
        warning:
          error instanceof Error
            ? error.message
            : "Shopify sales channels could not be loaded",
      })),
    getProductTemplates(admin)
      .then((value) => ({ ...value, warning: "" }))
      .catch((error) => ({
        themeId: null,
        themeName: "",
        templates: [""],
        warning:
          error instanceof Error
            ? error.message
            : "Product templates could not be loaded",
      })),
    getShippingConfiguration(admin)
      .then((configuration) => ({ ...configuration, warning: "" }))
      .catch((error) => ({
        marketDrivenShipping: null,
        profiles: [],
        warning:
          error instanceof Error
            ? error.message
            : "Shopify shipping profiles could not be loaded",
      })),
    prisma.syncProduct.count({
      where: { shop: session.shop, individualMarkup: { not: null } },
    }),
    initialTab === "variants"
      ? prisma.syncProduct.findMany({
          where: { shop: session.shop, trendsDataJson: { not: null } },
          select: {
            id: true,
            productCode: true,
            title: true,
            trendsDataJson: true,
            configuredVariantEnabled: true,
            configuredVariantJson: true,
            shopifyProductId: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const variantTypes = parseVariantTypes(settings.variantTypesJson);
  const activeSettingsJob = await prisma.cronSyncLog.findFirst({
    where: { shop: session.shop, mode: "settings", status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });
  const storefrontLinks = variantProducts.length
    ? await loadStorefrontProductLinks(admin, variantProducts, session.shop)
    : new Map();
  const variantMatches = summarizeVariantMatches(variantProducts, variantTypes);
  for (const items of Object.values(variantMatches)) {
    for (const item of items) {
      const product = variantProducts.find((row) => row.id === item.id);
      item.storefrontUrl = product?.shopifyProductId
        ? storefrontLinks.get(product.shopifyProductId) || null
        : null;
    }
  }
  return {
    settings: {
      trendsBaseUrl: settings.trendsBaseUrl,
      globalMarkupPercent: settings.globalMarkupPercent,
      fixedShippingAmount: settings.fixedShippingAmount,
      quoteNotificationEmail: settings.quoteNotificationEmail || "",
      inventoryLocationId: settings.inventoryLocationId,
      productTemplateSuffix: settings.productTemplateSuffix || "",
      shippingProfileId: settings.shippingProfileId || "",
      selectedPublicationIds: settings.selectedPublicationIdsJson
        ? parseIds(settings.selectedPublicationIdsJson)
        : salesChannelResult.salesChannels
            .filter((channel) => channel.supportsFuturePublishing)
            .map((channel) => channel.publicationId),
    },
    tokenConfigured: Boolean(settings.encryptedTrendsToken),
    locations: (await response.json()).data?.locations?.nodes || [],
    salesChannels: salesChannelResult.salesChannels,
    salesChannelsWarning: salesChannelResult.warning,
    productTemplates: templateResult.templates,
    themeName: templateResult.themeName,
    templatesWarning: templateResult.warning,
    shippingProfiles: shippingProfileResult.profiles,
    marketDrivenShipping: shippingProfileResult.marketDrivenShipping,
    shippingProfilesWarning: shippingProfileResult.warning,
    markupOverrides: {
      main: mainOverrideCount,
    },
    variantTypes,
    variantMatches,
    aiSettings: {
      enabled: settings.aiVariantClassificationEnabled,
      model: settings.aiVariantModel,
      keyConfigured: Boolean(settings.encryptedOpenAiApiKey),
    },
    activeSettingsJob: activeSettingsJob
      ? {
          id: activeSettingsJob.id,
          status: activeSettingsJob.status,
          total: activeSettingsJob.products,
          processed: activeSettingsJob.processed,
          updated: activeSettingsJob.updated,
          failed: activeSettingsJob.failed,
        }
      : null,
    initialTab,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const settings = await prisma.shopSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop },
    update: {},
  });
  if (form.get("intent") === "bulk_enable_configured_variants") {
    const ids = [...new Set(parseIds(String(form.get("ids") || "[]")))];
    if (!ids.length)
      return {
        ok: false,
        keepModal: true,
        message: "Select at least one product",
      };
    const products = await prisma.syncProduct.findMany({
      where: { shop: session.shop, id: { in: ids } },
      select: {
        id: true,
        trendsDataJson: true,
        configuredVariantJson: true,
        shopifyProductId: true,
      },
    });
    await ensureTrendsMetafieldDefinitions(admin);
    let enabled = 0;
    let failed = 0;
    for (const product of products) {
      try {
        const previous = product.configuredVariantJson
          ? JSON.parse(product.configuredVariantJson)
          : {};
        const configuration = product.trendsDataJson
          ? buildConfiguredVariant(
              JSON.parse(product.trendsDataJson),
              parseVariantTypes(settings.variantTypesJson),
              { ...previous, enabled: true },
            )
          : { ...previous, enabled: true, updatedAt: new Date().toISOString() };
        await prisma.syncProduct.update({
          where: { id: product.id },
          data: {
            configuredVariantEnabled: true,
            configuredVariantJson: JSON.stringify(configuration),
          },
        });
        if (product.shopifyProductId) {
          await setConfiguredVariantMetafield({
            admin,
            ownerId: product.shopifyProductId,
            configuration,
          });
        }
        enabled++;
      } catch {
        failed++;
      }
    }
    return {
      ok: failed === 0,
      keepModal: true,
      bulkEnabled: true,
      enabledIds: products.map((product) => product.id),
      message: `${enabled} product${enabled === 1 ? "" : "s"} enabled on the storefront${failed ? ` · ${failed} failed` : ""}`,
    };
  }
  if (form.get("intent") === "save_ai_settings") {
    const apiKey = String(form.get("openAiApiKey") || "").trim();
    if (apiKey && !apiKey.startsWith("sk-"))
      return { ok: false, message: "Enter a valid OpenAI API key" };
    try {
      const updated = await prisma.shopSettings.update({
        where: { shop: session.shop },
        data: {
          aiVariantClassificationEnabled: form
            .getAll("enabled")
            .map(String)
            .includes("true"),
          aiVariantModel:
            String(form.get("model") || "gpt-5-mini").trim() || "gpt-5-mini",
          ...(apiKey ? { encryptedOpenAiApiKey: encryptSecret(apiKey) } : {}),
        },
      });
      return {
        ok: true,
        aiSettingsSaved: true,
        keyConfigured: Boolean(updated.encryptedOpenAiApiKey),
        message: apiKey
          ? "OpenAI API key encrypted and saved"
          : "AI variant settings saved",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        ok: false,
        message: /encryptedOpenAiApiKey|Unknown column|does not exist/i.test(
          message,
        )
          ? "AI database fields are missing. Run the production Prisma schema update, then try again."
          : "OpenAI settings could not be saved",
      };
    }
  }
  if (form.get("intent") === "classify_ai_variants") {
    if (!settings.aiVariantClassificationEnabled)
      return { ok: false, message: "Enable AI variant suggestions first" };
    if (!settings.encryptedOpenAiApiKey)
      return { ok: false, message: "Save an OpenAI API key first" };
    const offset = Math.max(0, Number(form.get("offset") || 0));
    const previousFailed = Math.max(0, Number(form.get("failed") || 0));
    const products = await prisma.syncProduct.findMany({
      where: { shop: session.shop, trendsDataJson: { not: null } },
      orderBy: { id: "asc" },
      skip: offset,
      take: 10,
      select: { id: true, trendsDataJson: true, configuredVariantJson: true },
    });
    let completed = 0;
    let failed = 0;
    const apiKey = decryptSecret(settings.encryptedOpenAiApiKey);
    for (const product of products) {
      try {
        const source = JSON.parse(product.trendsDataJson);
        const previous = product.configuredVariantJson
          ? JSON.parse(product.configuredVariantJson)
          : {};
        const normal = buildConfiguredVariant(
          source,
          parseVariantTypes(settings.variantTypesJson),
          previous,
        );
        const suggestion = await classifyProductVariantsWithAi({
          apiKey,
          model: settings.aiVariantModel,
          product: source,
          existingOptionTypes: normal.options,
        });
        await prisma.syncProduct.update({
          where: { id: product.id },
          data: {
            configuredVariantJson: JSON.stringify({
              ...normal,
              aiSuggestion: suggestion || {
                status: "no_suggestion",
                source: "ai",
                model: settings.aiVariantModel,
                generatedAt: new Date().toISOString(),
                options: [],
              },
            }),
          },
        });
        completed++;
      } catch {
        failed++;
      }
    }
    const total = await prisma.syncProduct.count({
      where: { shop: session.shop, trendsDataJson: { not: null } },
    });
    const nextOffset = offset + products.length;
    const totalFailed = previousFailed + failed;
    return {
      ok: totalFailed === 0,
      aiBatch: true,
      completed,
      failed: totalFailed,
      processed: Math.min(nextOffset, total),
      nextOffset: nextOffset < total ? nextOffset : null,
      total,
      message:
        nextOffset < total
          ? `AI reviewed ${nextOffset} of ${total} products`
          : `AI review complete · ${total - totalFailed} processed${totalFailed ? ` · ${totalFailed} failed` : ""}`,
    };
  }
  if (form.get("intent") === "save_variant_types") {
    const types = parseVariantTypes(
      String(form.get("variantTypesJson") || "[]"),
    );
    if (!types.length)
      return { ok: false, message: "Add at least one variant type" };
    await prisma.shopSettings.update({
      where: { shop: session.shop },
      data: { variantTypesJson: JSON.stringify(types) },
    });
    const products = await prisma.syncProduct.findMany({
      where: { shop: session.shop, trendsDataJson: { not: null } },
      select: {
        id: true,
        trendsDataJson: true,
        configuredVariantEnabled: true,
        configuredVariantJson: true,
        shopifyProductId: true,
      },
    });
    let configured = 0;
    let published = 0;
    let matchedRequestedType = 0;
    const publishAll = form.get("publishAll") === "true";
    const syncType = String(form.get("syncType") || "");
    const matchType = String(form.get("matchType") || "");
    if (publishAll || syncType) await ensureTrendsMetafieldDefinitions(admin);
    for (const product of products) {
      try {
        const previousConfiguration = product.configuredVariantJson
          ? JSON.parse(product.configuredVariantJson)
          : {};
        const config = buildConfiguredVariant(
          JSON.parse(product.trendsDataJson),
          types,
          {
            ...previousConfiguration,
            enabled: product.configuredVariantEnabled,
          },
        );
        await prisma.syncProduct.update({
          where: { id: product.id },
          data: {
            configuredVariantJson: config.options.length
              ? JSON.stringify(config)
              : null,
          },
        });
        if (config.options.length) configured++;
        const matchesRequestedType = syncType
          ? config.options.some((option) => option.key === syncType)
          : true;
        if (
          matchType &&
          config.options.some((option) => option.key === matchType)
        )
          matchedRequestedType++;
        if (
          (publishAll || syncType) &&
          matchesRequestedType &&
          config.options.length &&
          product.shopifyProductId
        ) {
          await setConfiguredVariantMetafield({
            admin,
            ownerId: product.shopifyProductId,
            configuration: config,
          });
          published++;
        }
      } catch {
        /* Keep malformed supplier records unchanged. */
      }
    }
    return {
      ok: true,
      message: matchType
        ? `${matchedRequestedType} product${matchedRequestedType === 1 ? "" : "s"} matched this field · Shopify was not changed`
        : `Variant types saved · ${configured} matching product(s) configured${publishAll || syncType ? ` · ${published} Shopify metafield(s) updated` : ""}`,
    };
  }
  if (form.get("intent") === "generate_product_ai_suggestion") {
    const id = String(form.get("id") || "");
    if (!settings.aiVariantClassificationEnabled)
      return {
        ok: false,
        keepModal: true,
        message: "Enable AI Help in General settings first",
      };
    if (!settings.encryptedOpenAiApiKey)
      return {
        ok: false,
        keepModal: true,
        message: "Save an OpenAI API key first",
      };
    const item = await prisma.syncProduct.findFirst({
      where: { id, shop: session.shop },
    });
    if (!item?.trendsDataJson)
      return {
        ok: false,
        keepModal: true,
        message: "Fetch this product from TRENDS first",
      };
    try {
      const source = JSON.parse(item.trendsDataJson);
      const previous = item.configuredVariantJson
        ? JSON.parse(item.configuredVariantJson)
        : {};
      const normal = buildConfiguredVariant(
        source,
        parseVariantTypes(settings.variantTypesJson),
        previous,
      );
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
        keepModal: true,
        configuration,
        message: suggestion?.options?.length
          ? `${suggestion.options.length} AI suggestion${suggestion.options.length === 1 ? "" : "s"} ready for review`
          : "AI found no additional variant fields",
      };
    } catch (error) {
      return {
        ok: false,
        keepModal: true,
        message: error instanceof Error ? error.message : "AI Help failed",
      };
    }
  }
  if (form.get("intent") === "accept_product_ai_suggestion") {
    const id = String(form.get("id") || "");
    const item = await prisma.syncProduct.findFirst({
      where: { id, shop: session.shop },
    });
    if (!item?.trendsDataJson || !item.configuredVariantJson)
      return {
        ok: false,
        keepModal: true,
        message: "AI suggestion was not found",
      };
    const previous = JSON.parse(item.configuredVariantJson);
    const suggestion = previous.aiSuggestion;
    if (!suggestion?.options?.length)
      return {
        ok: false,
        keepModal: true,
        message: "There are no AI suggestions to approve",
      };
    const normal = buildConfiguredVariant(
      JSON.parse(item.trendsDataJson),
      parseVariantTypes(settings.variantTypesJson),
      previous,
    );
    const existingKeys = new Set(normal.options.map((option) => option.key));
    const accepted = suggestion.options
      .filter((option) => !existingKeys.has(option.key))
      .map((option) => ({ ...option, source: "ai", manual: true }));
    const options = [...normal.options, ...accepted];
    const configuration = {
      ...normal,
      options,
      variants: normal.variants.map((variant) => ({
        ...variant,
        attributes: {
          ...variant.attributes,
          ...Object.fromEntries(
            accepted
              .map((option) => [
                option.name,
                option.matches.find((match) => match.sku === variant.sku)
                  ?.value,
              ])
              .filter(([, value]) => value),
          ),
        },
        applicableOptionKeys: options
          .filter((option) =>
            option.matches?.some((match) => match.sku === variant.sku),
          )
          .map((option) => option.key),
      })),
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
      keepModal: true,
      configuration,
      message: `${accepted.length} AI field${accepted.length === 1 ? "" : "s"} approved and synced`,
    };
  }
  if (form.get("intent") === "configured_variant") {
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
    await prisma.syncProduct.update({
      where: { id },
      data: {
        configuredVariantEnabled: enabled,
        configuredVariantJson: JSON.stringify(configuration),
      },
    });
    if (item.shopifyProductId) {
      await ensureTrendsMetafieldDefinitions(admin);
      await setConfiguredVariantMetafield({
        admin,
        ownerId: item.shopifyProductId,
        configuration,
      });
    }
    return { ok: true, message: "Configured variant saved" };
  }
  if (form.get("intent") === "test") {
    const token = settings.encryptedTrendsToken || "";
    if (!token) return { ok: false, message: "Save the TRENDS token first" };
    try {
      const product = await new TrendsClient(
        settings.trendsBaseUrl,
        token,
      ).getProduct(String(form.get("testProductCode") || "125567"));
      return {
        ok: true,
        message: `Connected: ${product.code} — ${product.name}`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }
  if (form.get("intent") === "apply_settings_batch") {
    const jobId = String(form.get("jobId") || "");
    const job = await prisma.cronSyncLog.findFirst({
      where: { id: jobId, shop: session.shop, mode: "settings" },
    });
    if (!job)
      return {
        ok: false,
        settingsBatch: true,
        message: "Settings update was not found",
      };
    if (job.status !== "RUNNING")
      return {
        ok: job.status === "COMPLETED",
        settingsBatch: true,
        jobId,
        status: job.status,
        processed: job.processed,
        updated: job.updated,
        failed: job.failed,
        total: job.products,
        complete: true,
        message:
          job.status === "COMPLETED"
            ? "Settings update completed"
            : "Settings update needs attention",
      };
    const details = safeJsonArray(job.detailsJson);
    const internal = details.find((item) => item.internal && item.job);
    if (!internal?.job) {
      await prisma.cronSyncLog.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          failed: Math.max(1, job.failed),
          errorsJson: JSON.stringify([
            { message: "Settings job data is missing" },
          ]),
          finishedAt: new Date(),
        },
      });
      return {
        ok: false,
        settingsBatch: true,
        complete: true,
        jobId,
        message: "Settings job data is missing",
      };
    }
    const payload = internal.job;
    const batchIds = payload.productIds.slice(
      job.processed,
      job.processed + 10,
    );
    const rows = await prisma.syncProduct.findMany({
      where: { shop: session.shop, id: { in: batchIds } },
    });
    const rowById = new Map(rows.map((row) => [row.id, row]));
    let updated = job.updated;
    let failed = job.failed;
    const errors = safeJsonArray(job.errorsJson);
    const itemDetails = details.filter((item) => !item.internal);
    let locationId = null;
    let salesChannels = null;
    try {
      locationId = payload.requiresPricing
        ? await getPrimaryLocation(admin, payload.settings.inventoryLocationId)
        : null;
      salesChannels = payload.distributionChanged
        ? await getSalesChannels(admin)
        : null;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Shopify settings could not be loaded";
      await prisma.cronSyncLog.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          failed: Math.max(1, job.failed),
          remaining: Math.max(0, job.products - job.processed),
          errorsJson: JSON.stringify([...errors, { message }].slice(-250)),
          finishedAt: new Date(),
        },
      });
      return {
        ok: false,
        settingsBatch: true,
        complete: true,
        jobId,
        status: "FAILED",
        processed: job.processed,
        updated: job.updated,
        failed: Math.max(1, job.failed),
        total: job.products,
        message,
      };
    }
    for (const id of batchIds) {
      const row = rowById.get(id);
      if (!row) {
        failed += 1;
        errors.push({ message: `Product record ${id} was not found` });
        continue;
      }
      try {
        let synced = null;
        if (payload.requiresPricing) {
          synced = await syncTrendsPriceAndInventory({
            admin,
            shop: session.shop,
            product: JSON.parse(row.trendsDataJson),
            shopifyProductId: row.shopifyProductId,
            shopifyMasterProductId: row.shopifyMasterProductId,
            shopifyAdditionalProductId: row.shopifyAdditionalProductId,
            markupPercent:
              row.individualMarkup ?? payload.settings.globalMarkupPercent,
            fixedShippingAmount: payload.settings.fixedShippingAmount,
            locationId,
            customCorporatePackEnabled: row.customCorporatePackEnabled,
          });
        }
        if (payload.distributionChanged)
          await applyProductTemplateAndSalesChannels({
            admin,
            productId: row.shopifyProductId,
            templateSuffix: payload.settings.productTemplateSuffix,
            selectedPublicationIds: payload.settings.selectedPublicationIds,
            salesChannels,
          });
        if (
          payload.shippingProfileChanged &&
          payload.settings.shippingProfileId
        )
          await assignProductsToShippingProfile({
            admin,
            profileId: payload.settings.shippingProfileId,
            productIds: [
              row.shopifyProductId,
              synced?.masterProductId || row.shopifyMasterProductId,
            ],
          });
        await prisma.syncProduct.update({
          where: { id: row.id },
          data: {
            ...(synced
              ? { shopifyMasterProductId: synced.masterProductId }
              : {}),
            shopifyAdditionalProductId: null,
            lastSyncedAt: new Date(),
            lastError: null,
          },
        });
        updated += 1;
        itemDetails.push({
          status: "updated",
          action: "settings_applied",
          code: row.productCode,
          title: row.title || row.productCode,
          message: "Saved settings applied successfully",
        });
      } catch (error) {
        failed += 1;
        const message =
          error instanceof Error ? error.message : "Settings update failed";
        errors.push({ code: row.productCode, message });
        itemDetails.push({
          status: "failed",
          action: "settings_apply_failed",
          code: row.productCode,
          title: row.title || row.productCode,
          message,
        });
        await prisma.syncProduct.update({
          where: { id: row.id },
          data: { lastError: message.slice(0, 1000) },
        });
      }
    }
    const processed = Math.min(job.processed + batchIds.length, job.products);
    const complete = processed >= job.products;
    const status = complete
      ? failed === 0
        ? "COMPLETED"
        : updated > 0
          ? "PARTIAL"
          : "FAILED"
      : "RUNNING";
    if (complete && itemDetails[0]?.action === "settings_changed") {
      itemDetails[0] = {
        ...itemDetails[0],
        status: failed ? "failed" : "updated",
        message: failed
          ? `${itemDetails[0].message} · ${updated} updated, ${failed} failed`
          : `${itemDetails[0].message} · Applied to ${updated} products`,
      };
    }
    await prisma.cronSyncLog.update({
      where: { id: job.id },
      data: {
        status,
        processed,
        updated,
        failed,
        remaining: Math.max(0, job.products - processed),
        durationMs: Date.now() - job.startedAt.getTime(),
        errorsJson: JSON.stringify(errors.slice(-250)),
        detailsJson: JSON.stringify([internal, ...itemDetails.slice(-500)]),
        ...(complete ? { finishedAt: new Date() } : {}),
      },
    });
    return {
      ok: failed === 0,
      settingsBatch: true,
      jobId,
      status,
      processed,
      updated,
      failed,
      total: job.products,
      complete,
      message: complete
        ? failed
          ? `Settings applied to ${updated} products; ${failed} failed`
          : `Settings applied to all ${updated} products`
        : `Settings applied to ${processed} of ${job.products} products`,
    };
  }
  await releaseStaleSettingsJobs(session.shop);
  const runningSettingsJob = await prisma.cronSyncLog.findFirst({
    where: { shop: session.shop, mode: "settings", status: "RUNNING" },
    select: {
      id: true,
      products: true,
      processed: true,
      updated: true,
      failed: true,
    },
  });
  if (runningSettingsJob)
    return {
      ok: false,
      jobId: runningSettingsJob.id,
      status: "RUNNING",
      total: runningSettingsJob.products,
      processed: runningSettingsJob.processed,
      updated: runningSettingsJob.updated,
      failed: runningSettingsJob.failed,
      complete: false,
      message:
        "Finish the current settings update before saving another change",
    };
  const markup = Number(form.get("globalMarkupPercent"));
  if (!Number.isFinite(markup) || markup < 0 || markup > 1000)
    return { ok: false, message: "Markup must be between 0% and 1000%" };
  const tokenChanged = String(form.get("tokenChanged") || "") === "true";
  const token = tokenChanged
    ? String(form.get("trendsToken") || "")
        .trim()
        .replace(/^Bearer\s+/i, "")
    : "";
  const templateSuffix = String(form.get("productTemplateSuffix") || "")
    .trim()
    .replace(/^product\./i, "")
    .replace(/\.json$/i, "");
  if (templateSuffix && !/^[a-zA-Z0-9_-]+$/.test(templateSuffix))
    return {
      ok: false,
      message: "Template suffix can contain only letters, numbers, - and _",
    };
  const selectedPublicationIds = form
    .getAll("selectedPublicationIds")
    .map(String);
  const shippingProfileId = String(form.get("shippingProfileId") || "");
  const fixedShippingAmount = Number(form.get("fixedShippingAmount"));
  if (
    !Number.isFinite(fixedShippingAmount) ||
    fixedShippingAmount < 0 ||
    fixedShippingAmount > 100000
  )
    return {
      ok: false,
      message: "Fixed shipping must be between $0 and $100,000",
    };
  const normalizedQuoteRecipients = normalizeEmailRecipients(
    form.get("quoteNotificationEmail"),
  );
  if (normalizedQuoteRecipients.invalid.length)
    return {
      ok: false,
      message: `Invalid quote notification email: ${normalizedQuoteRecipients.invalid.join(", ")}`,
    };
  if (normalizedQuoteRecipients.tooMany)
    return {
      ok: false,
      message: "Add no more than 20 quote notification recipients",
    };
  const quoteNotificationEmail = normalizedQuoteRecipients.value;
  const legacyTaxSettingsPresent =
    Number(settings.gstRate || 0) !== 0 || settings.pricesExcludeGst !== false;
  const previousPublicationIds = settings.selectedPublicationIdsJson
    ? parseIds(settings.selectedPublicationIdsJson)
    : null;
  const updatedSettings = await prisma.shopSettings.update({
    where: { shop: session.shop },
    data: {
      trendsBaseUrl: String(
        form.get("trendsBaseUrl") || "https://nz.api.trends.nz",
      ).replace(/\/$/, ""),
      globalMarkupPercent: markup,
      fixedShippingAmount,
      quoteNotificationEmail: quoteNotificationEmail || null,
      gstRate: 0,
      pricesExcludeGst: false,
      inventoryLocationId:
        String(form.get("inventoryLocationId") || "") || null,
      productTemplateSuffix: templateSuffix || null,
      shippingProfileId: shippingProfileId || null,
      selectedPublicationIdsJson: JSON.stringify(selectedPublicationIds),
      ...(token ? { encryptedTrendsToken: token } : {}),
    },
  });

  const mainMarkupChanged = markup !== settings.globalMarkupPercent;
  const fixedShippingChanged =
    fixedShippingAmount !== settings.fixedShippingAmount;
  const quoteNotificationEmailChanged =
    quoteNotificationEmail !== (settings.quoteNotificationEmail || "");
  const distributionChanged =
    templateSuffix !== (settings.productTemplateSuffix || "") ||
    previousPublicationIds === null ||
    JSON.stringify([...selectedPublicationIds].sort()) !==
      JSON.stringify([...previousPublicationIds].sort());
  const shippingProfileChanged =
    shippingProfileId !== (settings.shippingProfileId || "");
  const inventoryLocationChanged =
    (updatedSettings.inventoryLocationId || "") !==
    (settings.inventoryLocationId || "");
  const changedSettings = describeSettingChanges(
    settings,
    updatedSettings,
    tokenChanged,
  );
  if (
    !mainMarkupChanged &&
    !fixedShippingChanged &&
    !quoteNotificationEmailChanged &&
    !legacyTaxSettingsPresent &&
    !distributionChanged &&
    !shippingProfileChanged &&
    !inventoryLocationChanged &&
    !tokenChanged
  )
    return { ok: true, settingsSaved: true, message: "No settings changed" };

  const overrideProductMarkups =
    String(form.get("markupOverrideMode") || "preserve") === "override";
  if (overrideProductMarkups) {
    await prisma.syncProduct.updateMany({
      where: { shop: session.shop },
      data: { individualMarkup: null },
    });
  }

  const requiresPricing =
    mainMarkupChanged ||
    fixedShippingChanged ||
    legacyTaxSettingsPresent ||
    inventoryLocationChanged;
  const products =
    requiresPricing || distributionChanged || shippingProfileChanged
      ? [
          ...new Map(
            (
              await prisma.syncProduct.findMany({
                where: {
                  shop: session.shop,
                  status: "SYNCED",
                  shopifyProductId: { not: null },
                  ...(requiresPricing ? { trendsDataJson: { not: null } } : {}),
                  ...(mainMarkupChanged &&
                  !fixedShippingChanged &&
                  !legacyTaxSettingsPresent &&
                  !distributionChanged &&
                  !shippingProfileChanged &&
                  !overrideProductMarkups
                    ? { individualMarkup: null }
                    : {}),
                },
                orderBy: { lastSyncedAt: "desc" },
              })
            ).map((row) => [row.shopifyProductId, row]),
          ).values(),
        ]
      : [];
  const productIds = products.map((row) => row.id);
  const summary = {
    status: productIds.length ? "queued" : "updated",
    action: "settings_changed",
    title: "Store settings changed",
    message: changedSettings.length
      ? changedSettings.join(", ")
      : "Connection settings updated",
    changes: changedSettings,
  };
  const payload = {
    productIds,
    requiresPricing,
    distributionChanged,
    shippingProfileChanged,
    settings: {
      globalMarkupPercent: updatedSettings.globalMarkupPercent,
      fixedShippingAmount: updatedSettings.fixedShippingAmount,
      inventoryLocationId: updatedSettings.inventoryLocationId,
      productTemplateSuffix: updatedSettings.productTemplateSuffix || "",
      shippingProfileId: updatedSettings.shippingProfileId || "",
      selectedPublicationIds,
    },
  };
  const job = await prisma.cronSyncLog.create({
    data: {
      shop: session.shop,
      mode: "settings",
      status: productIds.length ? "RUNNING" : "COMPLETED",
      products: productIds.length,
      remaining: productIds.length,
      detailsJson: JSON.stringify([summary, { internal: true, job: payload }]),
      ...(!productIds.length ? { finishedAt: new Date() } : {}),
    },
  });
  return {
    ok: true,
    settingsSaved: true,
    jobId: job.id,
    total: productIds.length,
    processed: 0,
    updated: 0,
    failed: 0,
    complete: productIds.length === 0,
    message: productIds.length
      ? `Settings saved. Applying changes to ${productIds.length} products.`
      : "Settings saved. No existing products required an update.",
  };
};

export default function Settings() {
  const {
    settings,
    tokenConfigured,
    locations,
    salesChannels,
    salesChannelsWarning,
    productTemplates,
    themeName,
    templatesWarning,
    shippingProfiles,
    marketDrivenShipping,
    shippingProfilesWarning,
    markupOverrides,
    variantTypes,
    variantMatches,
    aiSettings,
    activeSettingsJob,
    initialTab,
  } = useLoaderData();
  const result = useActionData();
  const settingsFetcher = useFetcher();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [tokenValue, setTokenValue] = useState("");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenChanged, setTokenChanged] = useState(false);
  const [openAiKey, setOpenAiKey] = useState("");
  const [markupConfirmation, setMarkupConfirmation] = useState(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsProgress, setSettingsProgress] = useState(
    activeSettingsJob
      ? {
          jobId: activeSettingsJob.id,
          status: activeSettingsJob.status,
          processed: activeSettingsJob.processed,
          updated: activeSettingsJob.updated,
          failed: activeSettingsJob.failed,
          total: activeSettingsJob.total,
          complete: false,
          message: `Resuming settings update from ${activeSettingsJob.processed} of ${activeSettingsJob.total} products`,
        }
      : null,
  );
  const activeTab = initialTab;
  const [editableVariantTypes, setEditableVariantTypes] =
    useState(variantTypes);
  const handledActionResponse = useRef(null);
  const handledSettingsResponse = useRef(null);
  const settingsFormRef = useRef(null);
  const savedSettingsSignature = useRef("");
  const resumedSettingsJob = useRef(false);
  useEffect(() => {
    savedSettingsSignature.current = settingsFormSignature(
      settingsFormRef.current,
    );
  }, []);
  useEffect(() => {
    if (!activeSettingsJob || resumedSettingsJob.current) return;
    resumedSettingsJob.current = true;
    settingsFetcher.submit(
      { intent: "apply_settings_batch", jobId: activeSettingsJob.id },
      { method: "post" },
    );
  }, [activeSettingsJob, settingsFetcher]);
  useEffect(() => {
    if (result?.message && handledActionResponse.current !== result) {
      handledActionResponse.current = result;
      shopify.toast.show(result.message, { isError: !result.ok });
      if (result.ok && result.aiSettingsSaved) setOpenAiKey("");
    }
  }, [result, shopify]);
  useEffect(() => {
    const response = settingsFetcher.data;
    if (
      settingsFetcher.state !== "idle" ||
      !response ||
      handledSettingsResponse.current === response
    )
      return;
    handledSettingsResponse.current = response;
    if (response.settingsSaved) {
      savedSettingsSignature.current = settingsFormSignature(
        settingsFormRef.current,
      );
      setSettingsDirty(false);
      setTokenChanged(false);
      setTokenValue("");
    }
    if (response.jobId) {
      setSettingsProgress({
        jobId: response.jobId,
        status:
          response.status || (response.complete ? "COMPLETED" : "RUNNING"),
        processed: response.processed || 0,
        updated: response.updated || 0,
        failed: response.failed || 0,
        total: response.total || 0,
        complete: Boolean(response.complete),
        message: response.message,
      });
    }
    if (
      response.jobId &&
      !response.complete &&
      (response.status || "RUNNING") === "RUNNING"
    ) {
      settingsFetcher.submit(
        { intent: "apply_settings_batch", jobId: response.jobId },
        { method: "post" },
      );
      return;
    }
    shopify.toast.show(response.message, { isError: !response.ok });
  }, [settingsFetcher, shopify]);
  const busy = navigation.state !== "idle" || settingsFetcher.state !== "idle";
  const settingsSyncing = Boolean(
    settingsProgress && !settingsProgress.complete,
  );
  const handleSettingsSubmit = (event) => {
    const formData = new FormData(event.currentTarget);
    const mainChanged =
      Number(formData.get("globalMarkupPercent")) !==
      settings.globalMarkupPercent;
    const affectedMainOverrides = mainChanged ? markupOverrides.main : 0;
    if (!affectedMainOverrides) return;

    event.preventDefault();
    setMarkupConfirmation({
      formData,
      main: affectedMainOverrides,
    });
  };
  const handleSettingsChange = (event) => {
    if (event.target?.name === "trendsToken") {
      setSettingsDirty(Boolean(event.target.value));
      return;
    }
    setSettingsDirty(
      settingsFormSignature(event.currentTarget) !==
        savedSettingsSignature.current || tokenChanged,
    );
  };
  const submitMarkupChoice = (mode) => {
    if (!markupConfirmation) return;
    markupConfirmation.formData.set("markupOverrideMode", mode);
    settingsFetcher.submit(markupConfirmation.formData, { method: "post" });
    setMarkupConfirmation(null);
  };
  return (
    <s-page heading="Settings" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={busy}
        disabled={busy || !settingsDirty || settingsSyncing}
        onClick={() => settingsFormRef.current?.requestSubmit()}
      >
        Save changes
      </s-button>
      <div className="trends-shell">
        <div
          className="trends-settings-tabs"
          role="tablist"
          aria-label="Settings sections"
        >
          <Link
            to="/app/settings"
            className={activeTab === "general" ? "is-active" : ""}
          >
            General
          </Link>
          <Link
            to="/app/settings?tab=variants"
            className={activeTab === "variants" ? "is-active" : ""}
          >
            Variant configuration
          </Link>
        </div>
        {activeTab === "general" ? (
          <>
            <div className="trends-hero">
              <div className="trends-hero__content">
                <p className="trends-eyebrow">Integration settings</p>
                <h2>Control how TRENDS products reach Shopify</h2>
                <p>
                  Manage the supplier connection, pricing rules and inventory
                  destination from one place.
                </p>
              </div>
              <div className="trends-hero__meta">
                {tokenConfigured ? "● API connected" : "○ Setup required"}
              </div>
            </div>
            {!tokenConfigured && (
              <s-banner tone="warning" heading="Complete the TRENDS connection">
                Add your API token below, save the settings, then test with a
                product code.
              </s-banner>
            )}
            <div className="trends-split trends-split--settings">
              <div className="trends-card trends-card--settings">
                <div className="trends-card__header">
                  <div>
                    <h3>Store configuration</h3>
                    <p>
                      Review and update the settings used whenever products are
                      imported into Shopify.
                    </p>
                  </div>
                  <s-badge tone={tokenConfigured ? "success" : "warning"}>
                    {tokenConfigured ? "Token saved" : "Not connected"}
                  </s-badge>
                </div>
                <div className="trends-card__body">
                  <settingsFetcher.Form
                    method="post"
                    onSubmit={handleSettingsSubmit}
                    onChange={handleSettingsChange}
                    ref={settingsFormRef}
                    className="trends-settings-form"
                  >
                    <input type="hidden" name="intent" value="save" />
                    {settingsProgress ? (
                      <div
                        className={`trends-settings-progress is-${settingsProgress.status.toLowerCase()}`}
                      >
                        <div className="trends-settings-progress__head">
                          <div>
                            <strong>
                              {settingsProgress.complete
                                ? settingsProgress.failed
                                  ? "Settings update finished with errors"
                                  : "Settings update complete"
                                : "Applying settings to products"}
                            </strong>
                            <small>{settingsProgress.message}</small>
                          </div>
                          <Link to="/app/logs?type=settings">
                            View Sync Activity
                          </Link>
                        </div>
                        <div
                          className="trends-settings-progress__track"
                          role="progressbar"
                          aria-valuemin="0"
                          aria-valuemax={settingsProgress.total || 1}
                          aria-valuenow={settingsProgress.processed}
                        >
                          <span
                            style={{
                              width: `${settingsProgress.total ? Math.round((settingsProgress.processed / settingsProgress.total) * 100) : 100}%`,
                            }}
                          />
                        </div>
                        <div className="trends-settings-progress__meta">
                          <span>
                            {settingsProgress.processed} of{" "}
                            {settingsProgress.total} products
                          </span>
                          <span>
                            {settingsProgress.total
                              ? Math.round(
                                  (settingsProgress.processed /
                                    settingsProgress.total) *
                                    100,
                                )
                              : 100}
                            % · {settingsProgress.updated} updated ·{" "}
                            {settingsProgress.failed} failed
                          </span>
                        </div>
                      </div>
                    ) : null}
                    <div className="trends-settings-groups">
                      <section className="trends-topic-card">
                        <div className="trends-topic-card__header">
                          <div>
                            <p className="trends-topic-card__eyebrow">
                              Connection
                            </p>
                            <h4>TRENDS API credentials</h4>
                            <p>
                              Connect this store to the supplier catalog and
                              secure product requests.
                            </p>
                          </div>
                          <s-badge
                            tone={tokenConfigured ? "success" : "warning"}
                          >
                            {tokenConfigured ? "Connected" : "Action required"}
                          </s-badge>
                        </div>
                        <div className="trends-topic-card__body trends-form-grid trends-form-grid--settings-pair">
                          <label className="trends-field">
                            TRENDS API URL
                            <input
                              className="trends-input"
                              name="trendsBaseUrl"
                              required
                              defaultValue={settings.trendsBaseUrl}
                            />
                            <small>
                              The base URL used for catalog and single-product
                              requests.
                            </small>
                          </label>
                          <label className="trends-field">
                            TRENDS bearer token
                            <span
                              className={`trends-secret-field${tokenVisible ? " trends-secret-field--visible" : ""}`}
                            >
                              <input
                                className="trends-input"
                                name="trendsToken"
                                type={tokenVisible ? "text" : "password"}
                                autoComplete="new-password"
                                value={tokenValue}
                                placeholder={
                                  tokenConfigured
                                    ? "Saved securely — enter a new token to replace it"
                                    : "Paste the API token"
                                }
                                onChange={(event) => {
                                  setTokenValue(event.target.value);
                                  setTokenChanged(true);
                                }}
                              />
                              <input
                                type="hidden"
                                name="tokenChanged"
                                value={String(tokenChanged)}
                              />
                              <button
                                type="button"
                                className="trends-secret-toggle"
                                aria-label={
                                  tokenVisible
                                    ? "Hide API token"
                                    : "Show API token"
                                }
                                onClick={() =>
                                  setTokenVisible((visible) => !visible)
                                }
                              >
                                {tokenVisible ? (
                                  <svg viewBox="0 0 20 20" aria-hidden="true">
                                    <path d="m3.1 1.7 15.2 15.2-1.4 1.4-2.6-2.6A8.3 8.3 0 0 1 10 17c-4.3 0-7.2-3.7-8-5.1a2.8 2.8 0 0 1 0-2.8A13 13 0 0 1 4.3 6L1.7 3.1l1.4-1.4Zm2.6 5.7A10.8 10.8 0 0 0 3.8 10c-.2.3-.2.7 0 1 1 1.6 3.3 4 6.2 4a6 6 0 0 0 2.8-.8l-1.5-1.5A4.1 4.1 0 0 1 7.3 8.7L5.7 7.4Zm4.5-4.4c4.1.1 6.9 3.7 7.8 5.1.5.9.5 1.9 0 2.8-.3.5-.8 1.2-1.5 2l-1.4-1.4c.5-.6.9-1.1 1.1-1.5.2-.3.2-.7 0-1-1-1.6-3.3-4-6.2-4h-.1L8 3.1c.7-.1 1.4-.2 2.2-.1Zm-.1 4a3 3 0 0 1 2.9 2.9L10.1 7Z" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 20 20" aria-hidden="true">
                                    <path d="M10 3.5c-4.3 0-7.2 3.7-8 5.1a2.8 2.8 0 0 0 0 2.8c.8 1.4 3.7 5.1 8 5.1s7.2-3.7 8-5.1a2.8 2.8 0 0 0 0-2.8c-.8-1.4-3.7-5.1-8-5.1Zm0 10.6a4.1 4.1 0 1 1 0-8.2 4.1 4.1 0 0 1 0 8.2Zm0-2.1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
                                  </svg>
                                )}
                              </button>
                            </span>
                            <span className="trends-secret-help">
                              <span className="trends-secret-help__status">
                                {tokenConfigured
                                  ? "✓ Token securely saved"
                                  : "Token required"}
                              </span>
                              <small>Saved for this store only.</small>
                            </span>
                          </label>
                        </div>
                      </section>
                      <section className="trends-topic-card">
                        <div className="trends-topic-card__header">
                          <div>
                            <p className="trends-topic-card__eyebrow">
                              Customer enquiries
                            </p>
                            <h4>Quote notifications</h4>
                            <p>
                              Choose where new Get a Quote submissions are
                              emailed for this store.
                            </p>
                          </div>
                        </div>
                        <div className="trends-topic-card__body trends-form-grid">
                          <div className="trends-field">
                            <s-text-field
                              label="Quote notification emails"
                              name="quoteNotificationEmail"
                              placeholder="info@reprographics.co.nz"
                              defaultValue={
                                settings.quoteNotificationEmail || ""
                              }
                            ></s-text-field>
                            <small>
                              Separate recipients with commas. Leave it blank to
                              use the SMTP account address.
                            </small>
                          </div>
                        </div>
                      </section>
                      <section className="trends-topic-card">
                        <div className="trends-topic-card__header">
                          <div>
                            <p className="trends-topic-card__eyebrow">
                              Commercial rules
                            </p>
                            <h4>Pricing</h4>
                            <p>
                              Define the default markup and shipping
                              contribution used during product sync. Taxes are
                              calculated by Shopify at checkout.
                            </p>
                          </div>
                        </div>
                        <div className="trends-topic-card__body trends-form-grid">
                          <div className="trends-form-grid trends-form-grid--two">
                            <label className="trends-field">
                              Final total markup (%)
                              <input
                                className="trends-input"
                                name="globalMarkupPercent"
                                type="number"
                                min="0"
                                max="1000"
                                step="0.01"
                                required
                                defaultValue={settings.globalMarkupPercent}
                              />
                              <small>
                                Applied once to the complete raw total: product,
                                branding, setup, gift packaging and fixed
                                shipping.
                              </small>
                            </label>
                            <label className="trends-field">
                              Fixed shipping amount (NZD)
                              <input
                                className="trends-input"
                                name="fixedShippingAmount"
                                type="number"
                                min="0"
                                max="100000"
                                step="0.01"
                                required
                                defaultValue={settings.fixedShippingAmount}
                              />
                              <small>
                                Added once per configured order before the final
                                markup is applied.
                              </small>
                            </label>
                          </div>
                        </div>
                      </section>
                      <section className="trends-topic-card">
                        <div className="trends-topic-card__header">
                          <div>
                            <p className="trends-topic-card__eyebrow">
                              Shopify destination
                            </p>
                            <h4>Inventory, template and shipping</h4>
                            <p>
                              Choose where inventory is assigned and how synced
                              products are configured in the storefront.
                            </p>
                          </div>
                        </div>
                        <div className="trends-topic-card__body trends-form-grid trends-form-grid--settings-pair">
                          <label className="trends-field">
                            Inventory location
                            <select
                              className="trends-input"
                              name="inventoryLocationId"
                              defaultValue={settings.inventoryLocationId || ""}
                            >
                              <option value="">
                                Automatically use the primary location
                              </option>
                              {locations.map((location) => (
                                <option key={location.id} value={location.id}>
                                  {location.name}
                                </option>
                              ))}
                            </select>
                            <small>
                              Stock quantities for every synced variant are
                              assigned here.
                            </small>
                          </label>
                          <label className="trends-field">
                            Product template suffix
                            <select
                              className="trends-input"
                              name="productTemplateSuffix"
                              defaultValue={settings.productTemplateSuffix}
                            >
                              {settings.productTemplateSuffix &&
                                !productTemplates.includes(
                                  settings.productTemplateSuffix,
                                ) && (
                                  <option
                                    value={settings.productTemplateSuffix}
                                  >
                                    {settings.productTemplateSuffix} (currently
                                    saved)
                                  </option>
                                )}
                              {productTemplates.map((suffix) => (
                                <option
                                  key={suffix || "default"}
                                  value={suffix}
                                >
                                  {suffix
                                    ? `product.${suffix}`
                                    : "Default product template"}
                                </option>
                              ))}
                            </select>
                            <small>
                              Templates from the published theme
                              {themeName ? ` (${themeName})` : ""}. This applies
                              to all existing and future synced products.
                            </small>
                            {templatesWarning && (
                              <small>
                                Could not load templates: {templatesWarning}
                              </small>
                            )}
                          </label>
                          {marketDrivenShipping === null ? (
                            <div className="trends-field">
                              <input
                                type="hidden"
                                name="shippingProfileId"
                                value={settings.shippingProfileId}
                              />
                              <strong>Shipping configuration unavailable</strong>
                              <small>{shippingProfilesWarning}</small>
                              <small>
                                Reload to verify the shipping setup for this store.
                                Your saved shipping profile is preserved.
                              </small>
                            </div>
                          ) : marketDrivenShipping ? (
                            <div className="trends-field">
                              <input
                                type="hidden"
                                name="shippingProfileId"
                                value={settings.shippingProfileId}
                              />
                              <strong>
                                Shipping: managed by Shopify Markets
                              </strong>
                              <small>
                                This store uses market-driven shipping.
                                Configure rates and their product/location
                                conditions in Shopify Settings → Markets.
                                Product sync no longer reads or modifies
                                merchant delivery profiles.
                              </small>
                            </div>
                          ) : (
                            <label className="trends-field">
                              Shipping profile (legacy stores)
                              <select
                                className="trends-input"
                                name="shippingProfileId"
                                defaultValue={settings.shippingProfileId}
                              >
                                <option value="">
                                  Do not manage shipping profile
                                </option>
                                {settings.shippingProfileId &&
                                  !shippingProfiles.some(
                                    (profile) =>
                                      profile.id === settings.shippingProfileId,
                                  ) && (
                                    <option value={settings.shippingProfileId}>
                                      Currently saved profile
                                    </option>
                                  )}
                                {shippingProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.name}
                                    {profile.default ? " (General)" : ""}
                                  </option>
                                ))}
                              </select>
                              <small>
                                Main and master products are assigned to this
                                Shopify shipping profile until the store moves
                                to market-driven shipping.
                              </small>
                              {shippingProfilesWarning && (
                                <small>
                                  Could not load shipping profiles:{" "}
                                  {shippingProfilesWarning}
                                </small>
                              )}
                            </label>
                          )}
                        </div>
                      </section>
                      <section className="trends-topic-card">
                        <div className="trends-topic-card__header">
                          <div>
                            <p className="trends-topic-card__eyebrow">
                              Availability
                            </p>
                            <h4>Sales channel publishing</h4>
                            <p>
                              Select the Shopify channels that receive every
                              synced product.
                            </p>
                          </div>
                        </div>
                        <div className="trends-topic-card__body">
                          <fieldset className="trends-field trends-market-fieldset">
                            <legend>Sales channels</legend>
                            <small>
                              Every synced product is published only to the
                              checked channels. Channel and publication IDs are
                              shown.
                            </small>
                            {salesChannelsWarning ? (
                              <s-banner tone="warning">
                                Sales channels could not be loaded:{" "}
                                {salesChannelsWarning}
                              </s-banner>
                            ) : salesChannels.length ? (
                              <div className="trends-market-list">
                                {salesChannels.map((channel) => (
                                  <label
                                    key={channel.publicationId}
                                    className="trends-market-option"
                                  >
                                    <input
                                      type="checkbox"
                                      name="selectedPublicationIds"
                                      value={channel.publicationId}
                                      defaultChecked={settings.selectedPublicationIds.includes(
                                        channel.publicationId,
                                      )}
                                    />
                                    <span>
                                      <strong>{channel.name}</strong>
                                      <small>Channel: {channel.id}</small>
                                      <small>
                                        Publication: {channel.publicationId}
                                      </small>
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ) : (
                              <small>
                                No Shopify sales channels were found.
                              </small>
                            )}
                          </fieldset>
                        </div>
                      </section>
                    </div>
                  </settingsFetcher.Form>
                </div>
              </div>
              <aside className="trends-settings-rail">
                <div className="trends-card">
                  <div className="trends-card__header">
                    <div>
                      <h3>Test connection</h3>
                      <p>Verify the saved credentials with a real product.</p>
                    </div>
                  </div>
                  <div className="trends-card__body">
                    <Form method="post">
                      <input type="hidden" name="intent" value="test" />
                      <div className="trends-form-grid">
                        <label className="trends-field">
                          Six-digit product code
                          <input
                            className="trends-input"
                            name="testProductCode"
                            defaultValue="125567"
                            inputMode="numeric"
                            pattern="[0-9]{6}"
                          />
                        </label>
                        <s-button
                          type="submit"
                          disabled={!tokenConfigured || busy}
                        >
                          Test TRENDS API
                        </s-button>
                      </div>
                    </Form>
                  </div>
                </div>
                <div className="trends-card trends-guidance-card">
                  <div className="trends-card__header">
                    <div>
                      <h3>Sync guidance</h3>
                      <p>How saved defaults are applied during product sync.</p>
                    </div>
                  </div>
                  <div className="trends-card__body">
                    <div className="trends-guidance-item">
                      <strong>Pricing calculation</strong>
                      <p>
                        The first TRENDS quantity-break price becomes the
                        Shopify variant price. Global markup is applied unless a
                        product-level markup overrides it.
                      </p>
                    </div>
                    <div className="trends-guidance-item">
                      <strong>Publishing status</strong>
                      <p>
                        Active TRENDS products publish as active. Draft or
                        inactive products remain draft; missing status defaults
                        to active.
                      </p>
                    </div>
                  </div>
                </div>
              </aside>
            </div>
            <div className="trends-card">
              <div className="trends-card__header">
                <div>
                  <h3>AI variant suggestions</h3>
                  <p>
                    Review unbranded SKU names and suggest new option types for
                    admin approval. AI never publishes directly.
                  </p>
                </div>
                <s-badge
                  tone={aiSettings.keyConfigured ? "success" : "warning"}
                >
                  {aiSettings.keyConfigured ? "AI connected" : "Key required"}
                </s-badge>
              </div>
              <div className="trends-card__body">
                <Form
                  method="post"
                  className="trends-form-grid trends-form-grid--settings-pair"
                >
                  <input type="hidden" name="intent" value="save_ai_settings" />
                  <label className="trends-variant-enabled">
                    <input
                      type="checkbox"
                      name="enabled"
                      value="true"
                      defaultChecked={aiSettings.enabled}
                    />
                    Enable AI suggestions for fetched products
                  </label>
                  <label className="trends-field">
                    OpenAI API key
                    <span className="trends-secret-field trends-secret-field--saved">
                      <input
                        className="trends-input"
                        type="password"
                        name="openAiApiKey"
                        value={openAiKey}
                        placeholder={
                          aiSettings.keyConfigured
                            ? "••••••••••••••••••••••••••••••••"
                            : "sk-..."
                        }
                        autoComplete="new-password"
                        onChange={(event) => {
                          setOpenAiKey(event.target.value);
                        }}
                      />
                      {aiSettings.keyConfigured && !openAiKey && (
                        <span className="trends-secret-saved-badge">Saved</span>
                      )}
                    </span>
                    <small>
                      {aiSettings.keyConfigured
                        ? "Key saved securely. Enter a new key only to replace it."
                        : "The key is encrypted and used only by the server."}
                    </small>
                  </label>
                  <label className="trends-field">
                    Classification model
                    <input
                      className="trends-input"
                      name="model"
                      defaultValue={aiSettings.model}
                    />
                  </label>
                  <div>
                    <s-button
                      type="submit"
                      variant="primary"
                      loading={busy}
                      disabled={busy}
                    >
                      Save AI settings
                    </s-button>
                  </div>
                </Form>
              </div>
            </div>
          </>
        ) : (
          <VariantConfigurationPanel
            types={editableVariantTypes}
            setTypes={setEditableVariantTypes}
            matches={variantMatches}
            busy={busy}
            aiSettings={aiSettings}
          />
        )}
        {markupConfirmation && (
          <MarkupConfirmationModal
            counts={markupConfirmation}
            busy={busy}
            onCancel={() => setMarkupConfirmation(null)}
            onPreserve={() => submitMarkupChoice("preserve")}
            onOverride={() => submitMarkupChoice("override")}
          />
        )}
      </div>
    </s-page>
  );
}
export const headers = (args) => boundary.headers(args);

function ViewportModalLayer({ children }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

function VariantConfigurationPanel({
  types,
  setTypes,
  matches,
  busy,
  aiSettings,
}) {
  const [newType, setNewType] = useState("");
  const [editingTypeKey, setEditingTypeKey] = useState(null);
  const [deletingTypeKey, setDeletingTypeKey] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [actionConfirmation, setActionConfirmation] = useState(null);
  const [aiReviewProgress, setAiReviewProgress] = useState(null);
  const [activeOperation, setActiveOperation] = useState(null);
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const handledResponse = useRef(null);
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.message &&
      handledResponse.current !== fetcher.data
    ) {
      handledResponse.current = fetcher.data;
      if (fetcher.data.aiBatch) {
        setAiReviewProgress({
          processed: fetcher.data.processed || 0,
          total: fetcher.data.total || 0,
          failed: fetcher.data.failed || 0,
          complete: fetcher.data.nextOffset === null,
          ok: fetcher.data.ok,
          message: fetcher.data.message,
        });
        if (fetcher.data.nextOffset !== null) {
          fetcher.submit(
            {
              intent: "classify_ai_variants",
              offset: String(fetcher.data.nextOffset),
              failed: String(fetcher.data.failed || 0),
            },
            { method: "post" },
          );
        } else {
          setActiveOperation(null);
          revalidator.revalidate();
        }
        return;
      }
      if (activeOperation === "ai_review") {
        setAiReviewProgress((current) => ({
          processed: current?.processed || 0,
          total: current?.total || 0,
          failed: Math.max(1, current?.failed || 0),
          complete: true,
          ok: false,
          message: fetcher.data.message || "AI review could not be completed",
        }));
        setActiveOperation(null);
        return;
      }
      shopify.toast.show(fetcher.data.message, {
        isError: !fetcher.data.ok,
      });
      if (fetcher.data.ok && !fetcher.data.keepModal) {
        setSelectedProduct(null);
        revalidator.revalidate();
      }
      if (fetcher.data.ok && fetcher.data.keepModal) revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, shopify, revalidator, activeOperation]);
  const addType = () => {
    const entered = newType
      .split(/[,;|]/)
      .map((value) => value.trim())
      .filter(Boolean);
    const name = entered[0] || "";
    if (!name) return;
    const key = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (
      !key ||
      ["other", "others"].includes(key) ||
      types.some((type) => type.key === key)
    )
      return;
    setTypes([
      ...types,
      {
        key,
        name,
        aliases: [...new Set(entered.map((value) => value.toLowerCase()))],
        values: [],
        enabled: true,
      },
    ]);
    setEditingTypeKey(key);
    setNewType("");
  };
  const builtInKeys = new Set(DEFAULT_VARIANT_TYPES.map((type) => type.key));
  const orderedTypes = [...types].sort((left, right) => {
    const matchDifference =
      (matches[right.key]?.length || 0) - (matches[left.key]?.length || 0);
    if (matchDifference) return matchDifference;
    return (
      Number(builtInKeys.has(right.key)) - Number(builtInKeys.has(left.key))
    );
  });
  const editingType = types.find((type) => type.key === editingTypeKey);
  const deletingType = types.find((type) => type.key === deletingTypeKey);
  const aiWorking = activeOperation === "ai_review";
  const working = busy || (fetcher.state !== "idle" && !aiWorking);
  const interactionLocked = busy || fetcher.state !== "idle";
  const runConfirmedAction = () => {
    if (!actionConfirmation) return;
    if (actionConfirmation.action === "bulk_enable") {
      fetcher.submit(
        {
          intent: "bulk_enable_configured_variants",
          ids: JSON.stringify(actionConfirmation.ids || []),
        },
        { method: "post" },
      );
      setActionConfirmation(null);
      return;
    }
    fetcher.submit(
      {
        intent: "save_variant_types",
        variantTypesJson: JSON.stringify(types),
        ...(actionConfirmation.action === "detect"
          ? { detectAll: "true" }
          : {}),
        ...(actionConfirmation.action === "sync_all"
          ? { publishAll: "true" }
          : {}),
        ...(actionConfirmation.action === "sync_type"
          ? { syncType: actionConfirmation.typeKey }
          : {}),
        ...(actionConfirmation.action === "match_type"
          ? { matchType: actionConfirmation.typeKey }
          : {}),
      },
      { method: "post" },
    );
    setActionConfirmation(null);
  };
  return (
    <div className="trends-variant-settings">
      <div className="trends-card__header">
        <div>
          <p className="trends-eyebrow">Storefront data standard</p>
          <h2>Variant configuration</h2>
          <p>
            Define recognised option types. Products are configured only when at
            least two distinct values can be matched—there is no generic “Other”
            category.
          </p>
        </div>
      </div>
      <Form method="post">
        <input type="hidden" name="intent" value="save_variant_types" />
        <input
          type="hidden"
          name="variantTypesJson"
          value={JSON.stringify(types)}
        />
        <div className="trends-variant-automation-bar">
          <div>
            <strong>Automatic variant setup</strong>
            <small>
              Detection updates this app only. Sync publishes ready
              configurations to Shopify.
            </small>
          </div>
          <div>
            <button
              type="button"
              className="trends-secondary-button"
              title="Scan saved TRENDS product data and refresh detected variant matches. Shopify is not changed."
              disabled={interactionLocked}
              onClick={() =>
                setActionConfirmation({
                  action: "detect",
                  title: "Detect variants for all products?",
                  body: "This scans the latest saved TRENDS data and refreshes detected configurations in the app. It will not update Shopify.",
                  confirmLabel: "Detect all products",
                })
              }
            >
              {working ? "Working…" : "Detect all products"}
            </button>
            <button
              type="button"
              className="trends-primary-button"
              title="Detect all ready configurations and update their Shopify product metafields."
              disabled={interactionLocked}
              onClick={() =>
                setActionConfirmation({
                  action: "sync_all",
                  title: "Sync all detected variants to Shopify?",
                  body: "This re-runs detection, saves the results and updates configured variant data for every matching Shopify product.",
                  confirmLabel: "Sync all to Shopify",
                })
              }
            >
              {working ? "Working…" : "Sync all to Shopify"}
            </button>
          </div>
        </div>
        <div className="trends-variant-automation-bar trends-ai-automation-bar">
          <div>
            <strong>AI Help</strong>
            <small>
              Manually analyse saved unbranded variant data for fields the
              normal detector could not classify. Nothing is saved or synced
              without admin approval.
            </small>
          </div>
          <div>
            <span
              className={`trends-source-badge ${aiSettings.enabled ? "is-ai" : "is-normal"}`}
            >
              {aiSettings.enabled ? "AI enabled" : "AI disabled"}
            </span>
            <button
              type="button"
              className="trends-primary-button"
              disabled={
                interactionLocked ||
                !aiSettings.enabled ||
                !aiSettings.keyConfigured
              }
              onClick={() => (
                setActiveOperation("ai_review"),
                setAiReviewProgress({
                  processed: 0,
                  total: 0,
                  failed: 0,
                  complete: false,
                  ok: true,
                  message: "Preparing product data…",
                }),
                fetcher.submit(
                  { intent: "classify_ai_variants", offset: "0", failed: "0" },
                  { method: "post" },
                )
              )}
            >
              {aiWorking ? "AI analysing…" : "Ask AI for help"}
            </button>
          </div>
        </div>
        <div className="trends-variant-add trends-variant-add--top">
          <div>
            <strong>Add option type</strong>
            <small>
              Add any future option such as sleeve length, capacity or finish.
            </small>
          </div>
          <input
            className="trends-input"
            value={newType}
            onChange={(event) => setNewType(event.target.value)}
            placeholder="Option name"
          />
          <s-button type="button" variant="primary" onClick={addType}>
            Add option
          </s-button>
        </div>
        <div className="trends-variant-type-list">
          {orderedTypes.map((type) => {
            const index = types.findIndex((row) => row.key === type.key);
            const items = matches[type.key] || [];
            return (
              <section className="trends-variant-type-card" key={type.key}>
                <header className="trends-variant-type-header">
                  <label className="trends-variant-enabled">
                    <input
                      type="checkbox"
                      checked={type.enabled !== false}
                      onChange={(event) =>
                        setTypes((current) =>
                          current.map((row, rowIndex) =>
                            rowIndex === index
                              ? { ...row, enabled: event.target.checked }
                              : row,
                          ),
                        )
                      }
                    />
                    <span>Enabled</span>
                  </label>
                  <div className="trends-variant-type-title">
                    <div>
                      <strong>{type.name}</strong>
                      <span
                        className={`trends-source-badge ${builtInKeys.has(type.key) ? "is-built-in" : "is-custom"}`}
                      >
                        {builtInKeys.has(type.key) ? "Built-in" : "Custom"}
                      </span>
                    </div>
                    <small>
                      {items.length} matching product
                      {items.length === 1 ? "" : "s"}
                    </small>
                  </div>
                  <span
                    className={`trends-variant-type-status ${items.length ? "is-ready" : "is-empty"}`}
                  >
                    {items.length ? "Detected" : "No matches"}
                  </span>
                  <button
                    type="button"
                    className="trends-variant-configure"
                    onClick={() => setEditingTypeKey(type.key)}
                  >
                    Edit rules
                  </button>
                  <button
                    type="button"
                    className="trends-variant-configure trends-variant-match"
                    disabled={interactionLocked || type.enabled === false}
                    title="Save this field and match it against currently fetched unbranded variant data. Shopify is not changed."
                    onClick={() =>
                      setActionConfirmation({
                        action: "match_type",
                        typeKey: type.key,
                        title: `Match ${type.name} with current data?`,
                        body: `This saves the current option name, detection keywords and known values, then scans all fetched unbranded variants for ${type.name}. Shopify will not be changed.`,
                        confirmLabel: "Match current data",
                      })
                    }
                  >
                    Match current data
                  </button>
                  <button
                    type="button"
                    className="trends-variant-sync"
                    title={`Update only the ${type.name} configuration for ${items.length} matching Shopify products.`}
                    disabled={!items.length || interactionLocked}
                    onClick={() =>
                      setActionConfirmation({
                        action: "sync_type",
                        typeKey: type.key,
                        title: `Sync ${type.name} to Shopify?`,
                        body: `This saves the current rules and updates ${items.length} matching Shopify product${items.length === 1 ? "" : "s"} for this option type only.`,
                        confirmLabel: `Sync ${items.length} products`,
                      })
                    }
                  >
                    {`Sync ${items.length || ""} products`}
                  </button>
                </header>
              </section>
            );
          })}
        </div>
        <div className="trends-variant-save">
          <div>
            <strong>Save changes in this app</strong>
            <small>Shopify products are not updated by this button.</small>
          </div>
          <s-button
            type="submit"
            loading={working}
            disabled={interactionLocked}
          >
            Save changes
          </s-button>
        </div>
      </Form>
      {editingType && (
        <VariantTypeModal
          type={editingType}
          items={matches[editingType.key] || []}
          builtIn={builtInKeys.has(editingType.key)}
          fetcher={fetcher}
          busy={interactionLocked}
          onEnableSelected={(ids) =>
            setActionConfirmation({
              action: "bulk_enable",
              ids,
              title: `Show ${ids.length} selected product${ids.length === 1 ? "" : "s"} on the storefront?`,
              body: "This sets enabled=true in custom_variant_configuration and syncs the selected product metafields to Shopify.",
              confirmLabel: "Enable and sync",
            })
          }
          onChange={(changes) =>
            setTypes((current) =>
              current.map((row) =>
                row.key === editingType.key ? { ...row, ...changes } : row,
              ),
            )
          }
          onProduct={setSelectedProduct}
          onDelete={() => setDeletingTypeKey(editingType.key)}
          onClose={() => setEditingTypeKey(null)}
        />
      )}
      {deletingType && (
        <VariantDeleteModal
          type={deletingType}
          onCancel={() => setDeletingTypeKey(null)}
          onConfirm={() => {
            setTypes((current) =>
              current.filter((row) => row.key !== deletingType.key),
            );
            setDeletingTypeKey(null);
            setEditingTypeKey(null);
          }}
        />
      )}
      {actionConfirmation && (
        <VariantActionConfirmModal
          value={actionConfirmation}
          busy={working}
          onCancel={() => !working && setActionConfirmation(null)}
          onConfirm={runConfirmedAction}
        />
      )}
      {selectedProduct && (
        <SettingsVariantModal
          item={selectedProduct}
          fetcher={fetcher}
          onClose={() => fetcher.state === "idle" && setSelectedProduct(null)}
        />
      )}
      {aiReviewProgress && (
        <AiReviewProgressModal
          value={aiReviewProgress}
          onClose={() => aiReviewProgress.complete && setAiReviewProgress(null)}
        />
      )}
    </div>
  );
}

function AiReviewProgressModal({ value, onClose }) {
  const percent = value.total
    ? Math.min(100, Math.round((value.processed / value.total) * 100))
    : 0;
  return (
    <ViewportModalLayer>
      <div className="trends-modal-backdrop is-confirm">
        <div
          className="trends-modal trends-modal--compact trends-ai-progress-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-review-progress-title"
        >
          <div className="trends-modal-header">
            <div>
              <p className="trends-eyebrow">AI Help</p>
              <h2 id="ai-review-progress-title">
                {value.complete ? "AI review complete" : "Reviewing products"}
              </h2>
            </div>
            {value.complete && (
              <button type="button" onClick={onClose} aria-label="Close">
                ×
              </button>
            )}
          </div>
          <div className="trends-modal-body">
            <div className="trends-ai-progress-status">
              {!value.complete && <span className="trends-spinner" />}
              <strong>
                {value.total
                  ? `${value.processed} of ${value.total} products`
                  : "Preparing product data…"}
              </strong>
              <span>{percent}%</span>
            </div>
            <div
              className="trends-progress-track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={percent}
            >
              <span
                className="trends-progress-bar"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="trends-ai-progress-meta">
              <span>
                {value.complete
                  ? value.message
                  : "Analysing unbranded variants and preparing suggestions"}
              </span>
              {value.failed > 0 && (
                <span className="is-failed">{value.failed} failed</span>
              )}
            </div>
          </div>
          {value.complete && (
            <div className="trends-modal-footer">
              <button
                type="button"
                className="trends-primary-button"
                onClick={onClose}
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </ViewportModalLayer>
  );
}

function VariantTypeModal({
  type,
  items,
  builtIn,
  fetcher,
  busy,
  onEnableSelected,
  onChange,
  onProduct,
  onDelete,
  onClose,
}) {
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState([]);
  const perPage = 20;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const visibleItems = items.slice((page - 1) * perPage, page * perPage);
  const allVisibleSelected =
    visibleItems.length > 0 &&
    visibleItems.every((item) => selectedIds.includes(String(item.id)));
  const toggleItem = (id) => {
    const value = String(id);
    setSelectedIds((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  };
  const toggleVisible = () => {
    const visibleIds = visibleItems.map((item) => String(item.id));
    setSelectedIds((current) =>
      allVisibleSelected
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])],
    );
  };
  const enableSelected = () => {
    if (!selectedIds.length || busy) return;
    onEnableSelected([...selectedIds]);
  };
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.bulkEnabled) {
      setSelectedIds([]);
    }
  }, [fetcher.state, fetcher.data]);
  return (
    <ViewportModalLayer>
      <div
        className="trends-modal-backdrop is-viewport-centered"
        onMouseDown={onClose}
      >
        <div
          className="trends-modal trends-modal--variant-type"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="trends-modal-header">
            <div>
              <div className="trends-modal-kicker">
                <span
                  className={`trends-source-badge ${builtIn ? "is-built-in" : "is-custom"}`}
                >
                  {builtIn ? "Built-in" : "Custom"}
                </span>
                <span>
                  {items.length ? "Values detected" : "Awaiting matches"}
                </span>
              </div>
              <h2>Configure {type.name}</h2>
              <small>
                Control detection and review every matching product.
              </small>
            </div>
            <button type="button" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
          <div className="trends-modal-body">
            <div className="trends-type-modal-fields">
              <label className="trends-field">
                Customer-facing option name
                <input
                  className="trends-input"
                  value={type.name}
                  onChange={(event) => onChange({ name: event.target.value })}
                />
              </label>
              <label className="trends-field">
                Detection keywords
                <input
                  className="trends-input"
                  value={(type.aliases || []).join(", ")}
                  onChange={(event) =>
                    onChange({
                      aliases: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label className="trends-field">
                Known values (optional)
                <input
                  className="trends-input"
                  value={(type.values || []).join(", ")}
                  placeholder="e.g. Small, Medium, Large"
                  onChange={(event) =>
                    onChange({
                      values: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </div>
            <section className="trends-type-matches">
              <header>
                <div>
                  <strong>Matching products</strong>
                  <small>
                    {items.length} products identified from supplier data
                  </small>
                </div>
                <div className="trends-type-match-actions">
                  <span className="trends-count-badge">{items.length}</span>
                  <button
                    type="button"
                    className="trends-secondary-button"
                    onClick={toggleVisible}
                    disabled={!visibleItems.length || busy}
                  >
                    {allVisibleSelected ? "Clear page" : "Select page"}
                  </button>
                  <button
                    type="button"
                    className="trends-primary-button"
                    onClick={enableSelected}
                    disabled={!selectedIds.length || busy}
                    title="Set enabled=true in custom_variant_configuration and sync the selected products to Shopify."
                  >
                    {fetcher.state !== "idle"
                      ? "Enabling…"
                      : `Show on storefront${selectedIds.length ? ` (${selectedIds.length})` : ""}`}
                  </button>
                </div>
              </header>
              {visibleItems.length ? (
                <div className="trends-type-sku-grid">
                  {visibleItems.map((item) => (
                    <div
                      key={item.sku}
                      className={`trends-type-product-row ${selectedIds.includes(String(item.id)) ? "is-selected" : ""}`}
                    >
                      <label
                        className="trends-type-product-select"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(String(item.id))}
                          onChange={() => toggleItem(item.id)}
                          aria-label={`Select ${item.title}`}
                        />
                      </label>
                      <span className="trends-type-product-copy">
                        <strong>{item.title}</strong>
                        <small>SKU {item.sku}</small>
                      </span>
                      <span
                        className={`trends-source-badge ${item.configured ? "is-configured" : "is-detected"}`}
                      >
                        {item.configured ? "Configured" : "Detected"}
                      </span>
                      <button
                        type="button"
                        className="trends-product-view-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (item.storefrontUrl)
                            window.open(
                              item.storefrontUrl,
                              "_blank",
                              "noopener,noreferrer",
                            );
                        }}
                        disabled={!item.storefrontUrl}
                        title="View product on storefront"
                        aria-label={`View ${item.title} on storefront`}
                      >
                        <span aria-hidden="true">↗</span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="trends-empty-state">
                  No products currently match these keywords or known values.
                </div>
              )}
              {pages > 1 && (
                <div className="trends-inline-pagination">
                  <button
                    type="button"
                    disabled={page === 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    Page {page} of {pages}
                  </span>
                  <button
                    type="button"
                    disabled={page === pages}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </section>
          </div>
          <div className="trends-modal-footer">
            <button
              type="button"
              className="trends-danger-button"
              onClick={onDelete}
            >
              Delete option
            </button>
            <button
              type="button"
              className="trends-primary-button"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </ViewportModalLayer>
  );
}

function VariantDeleteModal({ type, onCancel, onConfirm }) {
  return (
    <ViewportModalLayer>
      <div className="trends-modal-backdrop is-confirm" onMouseDown={onCancel}>
        <div
          className="trends-modal trends-modal--compact"
          role="alertdialog"
          aria-modal="true"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="trends-modal-header">
            <div>
              <p className="trends-eyebrow">Confirm deletion</p>
              <h2>Delete {type.name}?</h2>
            </div>
          </div>
          <div className="trends-modal-body">
            <p className="trends-confirm-copy">
              This removes the option from variant detection after you save
              settings. Existing supplier or Shopify product data will not be
              deleted.
            </p>
          </div>
          <div className="trends-modal-footer">
            <button
              type="button"
              className="trends-secondary-button"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="trends-danger-button"
              onClick={onConfirm}
            >
              Delete option
            </button>
          </div>
        </div>
      </div>
    </ViewportModalLayer>
  );
}

function VariantActionConfirmModal({ value, busy, onCancel, onConfirm }) {
  return (
    <ViewportModalLayer>
      <div className="trends-modal-backdrop is-confirm" onMouseDown={onCancel}>
        <div
          className="trends-modal trends-modal--compact"
          role="alertdialog"
          aria-modal="true"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="trends-modal-header">
            <div>
              <p className="trends-eyebrow">Please confirm</p>
              <h2>{value.title}</h2>
            </div>
            <button type="button" onClick={onCancel} disabled={busy}>
              ×
            </button>
          </div>
          <div className="trends-modal-body">
            <p className="trends-confirm-copy">{value.body}</p>
          </div>
          <div className="trends-modal-footer">
            <button
              type="button"
              className="trends-secondary-button"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="trends-primary-button"
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? "Working…" : value.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </ViewportModalLayer>
  );
}

function SettingsVariantModal({ item, fetcher, onClose }) {
  const initial = item.configuration || {};
  const [enabled, setEnabled] = useState(Boolean(item.enabled));
  const [options, setOptions] = useState(initial.options || []);
  const [aiSuggestion, setAiSuggestion] = useState(
    initial.aiSuggestion || null,
  );
  const [primaryOptionKey, setPrimaryOptionKey] = useState(
    initial.primaryOptionKey || initial.options?.[0]?.key || "",
  );
  useEffect(() => {
    if (!fetcher.data?.keepModal || !fetcher.data?.configuration) return;
    const next = fetcher.data.configuration;
    setOptions(next.options || []);
    setAiSuggestion(next.aiSuggestion || null);
    setPrimaryOptionKey(next.primaryOptionKey || next.options?.[0]?.key || "");
  }, [fetcher.data]);
  const configurationPayload = {
    enabled,
    primaryOptionKey,
    options: options.map((option) => ({
      key: option.key,
      name: option.name,
      displayValues: option.displayValues || {},
      values: option.values || [],
      matches: option.matches || [],
      manual: option.manual === true,
      source: option.source || "normal",
    })),
    aiSuggestion,
  };
  const busy = fetcher.state !== "idle";
  return (
    <ViewportModalLayer>
      <div className="trends-modal-backdrop" onMouseDown={onClose}>
        <div
          className="trends-modal trends-modal--wide"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="trends-modal-header">
            <div>
              <p className="trends-eyebrow">
                {item.configured
                  ? "Configured product"
                  : "Detected configuration"}
              </p>
              <h2>{item.title}</h2>
              <small>SKU {item.sku}</small>
            </div>
            <button type="button" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="trends-modal-body">
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
                aria-label="Show configured variants on storefront"
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
                    Normal matching runs first. AI reviews this product’s
                    unbranded variant data and returns only additional fields
                    with their linked SKUs.
                  </small>
                </div>
                <button
                  type="button"
                  className="trends-secondary-button"
                  disabled={busy}
                  onClick={() =>
                    fetcher.submit(
                      {
                        intent: "generate_product_ai_suggestion",
                        id: item.id,
                      },
                      { method: "post" },
                    )
                  }
                >
                  {busy ? "AI analysing…" : "Ask AI for help"}
                </button>
              </section>
              {aiSuggestion?.options?.length > 0 && (
                <section className="trends-ai-suggestion-card">
                  <div>
                    <span className="trends-source-badge is-ai">
                      AI suggested
                    </span>
                    <strong>Review missing fields</strong>
                    <small>
                      Approving stores these values and immediately syncs the
                      product configuration to Shopify.
                    </small>
                  </div>
                  <div className="trends-ai-suggestion-options">
                    {aiSuggestion.options.map((option) => (
                      <span key={option.key}>
                        <b>
                          {option.name}{" "}
                          <em className="trends-source-badge is-ai">AI</em>
                        </b>
                        <small>
                          {option.values.length} values ·{" "}
                          {Math.round((option.confidence || 0) * 100)}%
                          confidence
                        </small>
                        <small>
                          SKUs:{" "}
                          {option.matches.map((match) => match.sku).join(", ")}
                        </small>
                      </span>
                    ))}
                  </div>
                  {aiSuggestion.status !== "approved" && (
                    <button
                      type="button"
                      className="trends-primary-button"
                      disabled={busy}
                      onClick={() =>
                        fetcher.submit(
                          {
                            intent: "accept_product_ai_suggestion",
                            id: item.id,
                          },
                          { method: "post" },
                        )
                      }
                    >
                      {busy ? "Approving…" : "Approve and sync"}
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
                  {options.map((option) => (
                    <div className="trends-storefront-option" key={option.key}>
                      <b>
                        {option.name}{" "}
                        <span
                          className={`trends-source-badge ${option.source === "ai" ? "is-ai" : "is-normal"}`}
                        >
                          {option.source === "ai" ? "AI" : "Normal"}
                        </span>
                      </b>
                      <div>
                        {option.values.map((value) => (
                          <button type="button" key={value}>
                            {option.displayValues?.[value] || value}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
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
                <label className="trends-field">
                  Main customer option
                  <select
                    className="trends-input"
                    value={primaryOptionKey}
                    onChange={(event) =>
                      setPrimaryOptionKey(event.target.value)
                    }
                  >
                    {options.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
              </section>
              <section className="trends-variant-section">
                <div className="trends-variant-section__heading">
                  <span className="trends-section-number">3</span>
                  <div>
                    <strong>Option configuration</strong>
                    <small>
                      Review labels, values and their linked supplier SKUs.
                    </small>
                  </div>
                  <span className="trends-count-badge">{options.length}</span>
                </div>
                {options.map((option, index) => (
                  <section className="trends-variant-group" key={option.key}>
                    <header className="trends-variant-group__header">
                      <span className="trends-variant-step">{index + 1}</span>
                      <div>
                        <strong>{option.name}</strong>
                        <small>
                          {option.values.length} values ·{" "}
                          {option.matches?.length || 0} linked variants
                        </small>
                      </div>
                      <label>
                        Customer label
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
                    </header>
                    <div className="trends-variant-value-cards">
                      {option.values.map((value) => {
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
                                  value={option.displayValues?.[value] ?? value}
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
                              <span>{linked.length} linked variants</span>
                              <div>
                                {linked.slice(0, 12).map((match) => (
                                  <code key={match.sku}>{match.sku}</code>
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
                  </section>
                ))}
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
                  Save product configuration
                </s-button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      </div>
    </ViewportModalLayer>
  );
}

function MarkupConfirmationModal({
  counts,
  busy,
  onCancel,
  onPreserve,
  onOverride,
}) {
  const total = counts.main;
  return (
    <ViewportModalLayer>
      <div className="trends-modal-backdrop" onMouseDown={onCancel}>
        <div
          className="trends-modal trends-modal--compact"
          role="dialog"
          aria-modal="true"
          aria-labelledby="markup-confirmation-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="trends-modal-header">
            <h2 id="markup-confirmation-title">Apply global markup?</h2>
            <button type="button" onClick={onCancel} aria-label="Close">
              ×
            </button>
          </div>
          <div className="trends-modal-body">
            <p className="trends-confirm-copy">
              {total} product{total === 1 ? " has" : "s have"} a
              product-specific markup. Should the new global markup replace
              those values?
            </p>
            <div className="trends-modal-actions">
              <s-button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </s-button>
              <s-button type="button" onClick={onPreserve} disabled={busy}>
                No, keep product markups
              </s-button>
              <s-button
                type="button"
                variant="primary"
                onClick={onOverride}
                disabled={busy}
              >
                Yes, override them
              </s-button>
            </div>
          </div>
        </div>
      </div>
    </ViewportModalLayer>
  );
}
