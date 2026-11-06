import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import {
  applyProductTemplateAndSalesChannels,
  assignVariantsToShippingProfile,
  brandingEntriesFor,
  calculateTrendsTierPrice,
  publishProductToOnlineStore,
} from "./shopify-sync.server";
import {
  configuredSelectionLabel,
  standardPackagingSelection,
} from "./trends-configured-identity.js";

const gqlErrors = (json, path) => [
  ...(json.errors || []).map((error) => error.message),
  ...(path(json)?.userErrors || []).map((error) => error.message),
];

const gid = (type, value) => {
  const text = String(value || "").trim();
  return text.startsWith("gid://") ? text : `gid://shopify/${type}/${text}`;
};

const configuredSku = (productCode) =>
  `CFG-${productCode}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

async function sourceContext(admin, productId, variantId) {
  const response = await admin.graphql(
    `#graphql
      query TemporaryVariantSource($productId: ID!, $variantId: ID!) {
        product(id: $productId) {
          id title status
          metafield(namespace: "trends", key: "product_configuration") { value }
          featuredMedia {
            id
            ... on MediaImage { image { url altText } }
          }
        }
        productVariant(id: $variantId) {
          id sku
          media(first: 1) {
            nodes {
              id
              ... on MediaImage { image { url altText } }
            }
          }
          selectedOptions { name value }
        }
      }
    `,
    { variables: { productId, variantId } },
  );
  const json = await response.json();
  if (json.errors?.length)
    throw new Error(json.errors.map((error) => error.message).join("; "));
  if (!json.data?.product || !json.data?.productVariant)
    throw new Error("Shopify source product or variant was not found");
  const variant = json.data.productVariant;
  const media = variant.media?.nodes?.[0];
  const productMedia = json.data.product.featuredMedia;
  variant.selectedImage = {
    mediaId: media?.id || productMedia?.id || null,
    url: media?.image?.url || productMedia?.image?.url || null,
    altText:
      media?.image?.altText ||
      productMedia?.image?.altText ||
      json.data.product.title,
  };
  return {
    product: json.data.product,
    variant,
  };
}

async function updateConfiguredVariantPrice(
  admin,
  productId,
  variantId,
  price,
  variantOptions,
) {
  const response = await admin.graphql(
    `#graphql
      mutation UpdateTemporaryConfiguredVariantPrice(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        productId,
        variants: [
          {
            id: variantId,
            price: price.toFixed(2),
            optionValues: variantOptions.map((option) => ({
              optionName: option.name,
              name: option.value,
            })),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = gqlErrors(
    json,
    (value) => value.data?.productVariantsBulkUpdate,
  );
  if (errors.length) throw new Error(errors.join("; "));
  const variant = json.data?.productVariantsBulkUpdate?.productVariants?.[0];
  if (!variant?.id)
    throw new Error("Shopify did not return the updated configuration variant");
  return variant;
}

const comparableOptionValue = (value) =>
  String(value || "")
    .replace(/[\u200B\u200C\u2063]/g, "")
    .replace(/Branding:\s*/gi, "Branding - ")
    .replace(/Packaging:\s*/gi, "Packaging - ")
    .replace(/\s*\|\s*Quantity:\s*\d+\s*$/i, "")
    .trim();

const sameVariantOptions = (selectedOptions, expectedOptions) =>
  expectedOptions.every((expected) =>
    selectedOptions.some(
      (selected) =>
        selected.name.toLowerCase() === expected.name.toLowerCase() &&
        comparableOptionValue(selected.value) ===
          comparableOptionValue(expected.value),
    ),
  );

const sameExactVariantOptions = (selectedOptions, expectedOptions) =>
  expectedOptions.every((expected) =>
    selectedOptions.some(
      (selected) =>
        selected.name.toLowerCase() === expected.name.toLowerCase() &&
        selected.value === expected.value,
    ),
  );

async function masterProductVariants(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      query TemporaryConfiguredMasterVariants($id: ID!) {
        product(id: $id) {
          id
          variants(first: 250) {
            nodes {
              id sku
              selectedOptions { name value }
              media(first: 1) { nodes { id } }
            }
          }
        }
      }
    `,
    { variables: { id: productId } },
  );
  const json = await response.json();
  if (json.errors?.length)
    throw new Error(json.errors.map((error) => error.message).join("; "));
  if (!json.data?.product)
    throw new Error("Configured master product was not found");
  return json.data.product.variants?.nodes || [];
}

async function createMasterConfigurationVariant({
  admin,
  productId,
  variantOptions,
  price,
  sku,
  mediaId,
  mediaUrl,
}) {
  const response = await admin.graphql(
    `#graphql
      mutation CreateMasterConfigurationVariant(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { id title price sku }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        productId,
        variants: [
          {
            optionValues: variantOptions.map((option) => ({
              optionName: option.name,
              name: option.value,
            })),
            inventoryItem: { sku },
            price: price.toFixed(2),
            inventoryPolicy: "CONTINUE",
            taxable: true,
            published: true,
            ...(mediaId
              ? { mediaId }
              : mediaUrl
                ? { mediaSrc: [mediaUrl] }
                : {}),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = gqlErrors(
    json,
    (value) => value.data?.productVariantsBulkCreate,
  );
  if (errors.length) throw new Error(errors.join("; "));
  const variant = json.data?.productVariantsBulkCreate?.productVariants?.[0];
  if (!variant?.id)
    throw new Error("Shopify did not return the configuration variant");
  return variant;
}

async function createConfigurationGroup(
  admin,
  source,
  variantOptions,
  price,
  sku,
  templateSuffix,
  selectedPublicationIds,
) {
  const imageFile = source.variant.selectedImage?.url
    ? {
        originalSource: source.variant.selectedImage.url,
        contentType: "IMAGE",
        alt: source.variant.selectedImage.altText || source.product.title,
      }
    : null;
  const response = await admin.graphql(
    `#graphql
      mutation CreateTemporaryConfigurationProduct($input: ProductSetInput!, $synchronous: Boolean!) {
        productSet(input: $input, synchronous: $synchronous) {
          product {
            id title
            variants(first: 1) { nodes { id title price sku } }
          }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        synchronous: true,
        input: {
          title: source.product.title,
          descriptionHtml:
            "<p>Temporary configured-order variants generated by the TRENDS integration.</p>",
          productType: "Configured order",
          vendor: "TRENDS",
          tags: [
            "TRENDS",
            "TRENDS Master Product",
            "TRENDS Hidden Product",
            "Configured order master",
          ],
          metafields: [
            {
              namespace: "seo",
              key: "hidden",
              type: "number_integer",
              value: "1",
            },
            {
              namespace: "trends",
              key: "temporary_configured_product",
              type: "boolean",
              value: "true",
            },
          ],
          status: "UNLISTED",
          ...(imageFile ? { files: [imageFile] } : {}),
          productOptions: variantOptions.map((option, index) => ({
            name: option.name,
            position: index + 1,
            values: [{ name: option.value }],
          })),
          variants: [
            {
              price: price.toFixed(2),
              sku,
              inventoryPolicy: "CONTINUE",
              taxable: true,
              published: true,
              ...(imageFile ? { file: imageFile } : {}),
              optionValues: variantOptions.map((option) => ({
                optionName: option.name,
                name: option.value,
              })),
            },
          ],
        },
      },
    },
  );
  const json = await response.json();
  const errors = gqlErrors(json, (value) => value.data?.productSet);
  if (errors.length) throw new Error(errors.join("; "));
  const product = json.data?.productSet?.product;
  const variant = product?.variants?.nodes?.[0];
  if (!product?.id || !variant?.id)
    throw new Error("Shopify did not return the configuration product");
  await publishProductToOnlineStore(admin, product.id);
  await applyProductTemplateAndSalesChannels({
    admin,
    productId: product.id,
    templateSuffix,
    selectedPublicationIds,
  });
  return { product, variant };
}

export async function createTemporaryConfiguredVariant({ admin, shop, input }) {
  const quantity = Math.trunc(Number(input.productQuantity ?? input.quantity));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100000)
    throw new Error("quantity must be between 1 and 100000");
  const variantSku = String(input.variantSku || "").trim();
  if (!variantSku) throw new Error("variantSku is required");
  if (!String(input.variantId || "").trim())
    throw new Error("variantId is required");
  const serviceAliases = {
    unbranded: "unbranded",
    branding: "branding",
    packaging: "gift_ready",
    gift_box: "gift_ready",
    gift_ready: "gift_ready",
  };
  const requestedService = String(input.service || "").toLowerCase();
  const legacyService = requestedService
    ? serviceAliases[requestedService]
    : null;
  if (requestedService && !legacyService)
    throw new Error(
      "service must be unbranded, branding, packaging, or gift_box",
    );

  const row = await prisma.syncProduct.findFirst({
    where: {
      shop,
      status: "SYNCED",
      shopifyProductId: { not: null },
      trendsDataJson: { not: null },
      OR: [{ productCode: variantSku }, { resolvedProductCode: variantSku }],
    },
    orderBy: { lastSyncedAt: "desc" },
  });
  let matchedRow = row;
  let product = row ? JSON.parse(row.trendsDataJson) : null;
  if (!matchedRow) {
    const rows = await prisma.syncProduct.findMany({
      where: {
        shop,
        status: "SYNCED",
        shopifyProductId: { not: null },
        trendsDataJson: { not: null },
      },
      orderBy: { lastSyncedAt: "desc" },
    });
    for (const candidate of rows) {
      const parsed = JSON.parse(candidate.trendsDataJson);
      if (
        (parsed.stock || []).some(
          (stock) => String(stock.stock_code) === variantSku,
        )
      ) {
        matchedRow = candidate;
        product = parsed;
        break;
      }
    }
  }
  if (!matchedRow || !product)
    throw new Error("This SKU is not a synced TRENDS product");

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const entries = brandingEntriesFor(product);
  const findEntry = (requestedValue, expectedMode, label) => {
    const requested = String(requestedValue || "").trim();
    if (!requested) return null;
    const entry = entries.find(
      (entry) =>
        String(entry.costKey) === requested ||
        entry.unitSku === requested ||
        entry.optionName === requested,
    );
    if (!entry) throw new Error(`A valid ${label} is required`);
    if (entry.mode !== expectedMode)
      throw new Error(`The selected ${label} is not a ${expectedMode} option`);
    return entry;
  };
  const legacyOption = input.brandingId || input.brandingSku || input.option;
  const brandingEntry = findEntry(
    input.brandingId || (legacyService === "branding" ? legacyOption : null),
    "branding",
    "brandingId",
  );
  const requestedPackaging =
    input.packagingId ||
    input.giftBoxId ||
    input.packagingSku ||
    input.giftBoxSku ||
    (legacyService === "gift_ready" ? legacyOption : null);
  const standardPackaging = standardPackagingSelection(requestedPackaging);
  const customCorporatePack =
    String(requestedPackaging || "").trim() === "custom-corporate-pack";
  if (customCorporatePack && !matchedRow.customCorporatePackEnabled)
    throw new Error("Custom Corporate Pack is not enabled for this product");
  const giftBoxEntry = standardPackaging || customCorporatePack
    ? null
    : findEntry(requestedPackaging, "gift_ready", "packagingId");
  if (legacyService === "branding" && !brandingEntry)
    throw new Error("A valid brandingId or brandingSku is required");
  if (
    legacyService === "gift_ready" &&
    !giftBoxEntry &&
    !standardPackaging &&
    !customCorporatePack
  )
    throw new Error("A valid packagingId or packagingSku is required");
  const optionQuantity = (value, fallback, label) => {
    const result = Math.trunc(Number(value ?? fallback));
    if (!Number.isFinite(result) || result < 1 || result > 100000)
      throw new Error(`${label} must be between 1 and 100000`);
    return result;
  };
  const brandingQuantity = brandingEntry
    ? optionQuantity(input.brandingQuantity, quantity, "brandingQuantity")
    : null;
  const packagingQuantity = giftBoxEntry || customCorporatePack
    ? optionQuantity(input.packagingQuantity, quantity, "packagingQuantity")
    : null;
  const packagingSelected = Boolean(
    giftBoxEntry || standardPackaging || customCorporatePack,
  );
  const packagingName =
    giftBoxEntry?.optionName ||
    standardPackaging?.name ||
    (customCorporatePack ? "Custom Corporate Pack" : null);
  const service =
    [brandingEntry && "branding", packagingSelected && "gift_box"]
      .filter(Boolean)
      .join("+") || "unbranded";

  const calculated = calculateTrendsTierPrice({
    product,
    quantity,
    markupPercent:
      matchedRow.individualMarkup ?? settings?.globalMarkupPercent ?? 0,
    fixedShippingAmount: settings?.fixedShippingAmount ?? 15,
    additionalSelections: [
      brandingEntry
        ? { sku: brandingEntry.unitSku, quantity: brandingQuantity }
        : null,
      giftBoxEntry
        ? { sku: giftBoxEntry.unitSku, quantity: packagingQuantity }
        : null,
      customCorporatePack
        ? {
            id: "custom-corporate-pack",
            name: "Custom Corporate Pack",
            mode: "gift_ready",
            sku: "CUSTOM-CORPORATE-PACK",
            quantity: packagingQuantity,
            unitPrice: 0,
            setupPrice: 0,
          }
        : null,
    ].filter(Boolean),
    shippingService: input.shippingService || input.freightService,
  });
  const sourceProductId = matchedRow.shopifyProductId;
  const sourceVariantId = gid("ProductVariant", input.variantId);
  const source = await sourceContext(admin, sourceProductId, sourceVariantId);
  if (source.variant.sku && source.variant.sku !== variantSku)
    throw new Error("variantId and variantSku do not match");

  const sku = configuredSku(product.code);
  const subtotal = calculated.subtotal;
  const price = Number((subtotal / quantity).toFixed(2));
  const colourOption = source.variant.selectedOptions.find((option) =>
    /colou?r|finish/i.test(option.name),
  );
  const fallbackOption = source.variant.selectedOptions.find(
    (option) => !/^default title$/i.test(option.value),
  );
  const typeLabel =
    brandingEntry && packagingSelected
      ? "Branded + Packaging"
      : packagingSelected
        ? "Gift Ready"
        : brandingEntry
          ? "Branded"
          : "Unbranded";
  const variantOptions = [
    { name: "Type", value: typeLabel },
    {
      name: "Colour",
      value: colourOption?.value || fallbackOption?.value || "Default",
    },
    {
      name: "Configuration",
      value: configuredSelectionLabel({
        brandingName: brandingEntry?.optionName,
        packagingName,
        quantity,
      }),
    },
  ];
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const configuration = {
    presentationVersion: 3,
    persistentMasterProduct: true,
    sourceProductId,
    sourceVariantId,
    variantSku,
    productCode: String(product.code),
    service,
    brandingId: brandingEntry ? String(brandingEntry.costKey) : null,
    brandingName: brandingEntry?.optionName || null,
    brandingQuantity,
    giftBoxId: giftBoxEntry
      ? String(giftBoxEntry.costKey)
      : standardPackaging?.id || null,
    giftBoxName: packagingName,
    packagingId: customCorporatePack
      ? "custom-corporate-pack"
      : giftBoxEntry
      ? String(giftBoxEntry.costKey)
      : standardPackaging?.id || null,
    packagingName,
    packagingQuantity,
    shippingService: calculated.shipping?.service || null,
    shipping: calculated.shipping,
    requestedQuantity: quantity,
    subtotal,
    calculated,
  };
  let targetProductId = matchedRow.shopifyMasterProductId;
  let variant;
  let reused = false;
  const createReplacementMaster = async () => {
    const created = await createConfigurationGroup(
      admin,
      source,
      variantOptions,
      price,
      sku,
      settings?.productTemplateSuffix,
      settings?.selectedPublicationIdsJson
        ? JSON.parse(settings.selectedPublicationIdsJson)
        : null,
    );
    targetProductId = created.product.id;
    variant = created.variant;
    configuration.persistentCoreVariant = !brandingEntry && !packagingSelected;
    await prisma.syncProduct.updateMany({
      where: {
        shop,
        OR: [
          { productCode: matchedRow.productCode },
          { resolvedProductCode: String(product.code) },
        ],
      },
      data: { shopifyMasterProductId: targetProductId },
    });
  };
  const createQuantitySpecificProduct = async () => {
    const created = await createConfigurationGroup(
      admin,
      source,
      variantOptions,
      price,
      sku,
      settings?.productTemplateSuffix,
      settings?.selectedPublicationIdsJson
        ? JSON.parse(settings.selectedPublicationIdsJson)
        : null,
    );
    targetProductId = created.product.id;
    variant = created.variant;
    configuration.persistentMasterProduct = false;
    configuration.persistentCoreVariant = false;
  };
  if (!targetProductId) {
    await createReplacementMaster();
  } else {
    let masterVariants;
    try {
      masterVariants = await masterProductVariants(admin, targetProductId);
    } catch (error) {
      if (!/not found|does not exist|was not found/i.test(String(error)))
        throw error;
      await createReplacementMaster();
    }
    if (!masterVariants) {
      // The stale database mapping has already been repaired above.
    } else {
      const visuallyMatchingVariants = masterVariants.filter((candidate) =>
        sameVariantOptions(candidate.selectedOptions || [], variantOptions),
      );
      const trackedMatches = visuallyMatchingVariants.length
        ? await prisma.temporaryConfiguredVariant.findMany({
            where: {
              shop,
              shopifyVariantId: {
                in: visuallyMatchingVariants.map((candidate) => candidate.id),
              },
            },
          })
        : [];
      const cleanCombinationExists = visuallyMatchingVariants.some(
        (candidate) =>
          sameExactVariantOptions(
            candidate.selectedOptions || [],
            variantOptions,
          ),
      );
      const matchingVariant = visuallyMatchingVariants.find((candidate) => {
        const tracked = trackedMatches.find(
          (row) => row.shopifyVariantId === candidate.id,
        );
        const quantityMatches = tracked
          ? tracked.requestedQuantity === quantity
          : new RegExp(`\\|\\s*Quantity:\\s*${quantity}\\s*$`, "i").test(
              candidate.selectedOptions?.find(
                (option) => option.name.toLowerCase() === "configuration",
              )?.value || "",
            );
        if (!quantityMatches) return false;
        return cleanCombinationExists
          ? sameExactVariantOptions(
              candidate.selectedOptions || [],
              variantOptions,
            )
          : true;
      });
      if (matchingVariant) {
        variant = await updateConfiguredVariantPrice(
          admin,
          targetProductId,
          matchingVariant.id,
          price,
          variantOptions,
        );
        reused = true;
        configuration.persistentCoreVariant = /^CFG-(?:BASE|CORE)-/.test(
          String(matchingVariant.sku || ""),
        );
      } else {
        const colourValue = variantOptions.find(
          (option) => option.name === "Colour",
        )?.value;
        const colourMediaId = masterVariants.find(
          (candidate) =>
            candidate.selectedOptions?.some(
              (option) =>
                /colou?r/i.test(option.name) && option.value === colourValue,
            ) && candidate.media?.nodes?.[0]?.id,
        )?.media?.nodes?.[0]?.id;
        try {
          variant = await createMasterConfigurationVariant({
            admin,
            productId: targetProductId,
            variantOptions,
            price,
            sku,
            mediaId: colourMediaId,
            mediaUrl: source.variant.selectedImage?.url,
          });
          configuration.persistentCoreVariant = false;
        } catch (error) {
          if (!/already exists|duplicate|option value/i.test(String(error)))
            throw error;
          await createQuantitySpecificProduct();
        }
      }
    }
  }

  await publishProductToOnlineStore(admin, targetProductId);
  await assignVariantsToShippingProfile({
    admin,
    profileId: settings?.shippingProfileId,
    variantIds: [variant.id],
  });

  await prisma.temporaryConfiguredVariant.upsert({
    where: { shopifyVariantId: variant.id },
    create: {
      shop,
      sourceProductId,
      sourceVariantId,
      targetProductId,
      shopifyVariantId: variant.id,
      productCode: String(product.code),
      variantSku,
      service,
      requestedQuantity: quantity,
      price,
      configurationJson: JSON.stringify(configuration),
      expiresAt,
    },
    update: {
      sourceProductId,
      sourceVariantId,
      targetProductId,
      productCode: String(product.code),
      variantSku,
      service,
      requestedQuantity: quantity,
      price,
      configurationJson: JSON.stringify(configuration),
      expiresAt,
    },
  });

  const numericVariantId = String(variant.id).split("/").pop();
  const lineProperties = {
    "Source SKU": variantSku,
    Service: service,
    "Requested quantity": String(quantity),
    ...(brandingEntry ? { "Branding option": brandingEntry.optionName } : {}),
    ...(brandingEntry ? { "Branding quantity": String(brandingQuantity) } : {}),
    ...(packagingSelected ? { "Packaging option": packagingName } : {}),
    ...(giftBoxEntry
      ? { "Packaging quantity": String(packagingQuantity) }
      : {}),
    ...(calculated.shipping ? { Shipping: calculated.shipping.name } : {}),
    ...(calculated.shippingCharge > 0
      ? {
          "Shipping charge": `${calculated.shippingCharge.toFixed(2)} NZD`,
        }
      : {}),
  };

  return {
    reusedExistingVariant: reused,
    variantId: variant.id,
    numericVariantId,
    productId: targetProductId,
    cartQuantity: quantity,
    requestedQuantity: quantity,
    price,
    lineSubtotal: Number((price * quantity).toFixed(2)),
    taxable: true,
    priceIncludesTax: false,
    subtotal,
    currency: "NZD",
    shipping: calculated.shipping,
    shippingCharge: calculated.shippingCharge,
    shippingOptions: calculated.shippingOptions,
    expiresAt: expiresAt.toISOString(),
    cartItem: {
      id: numericVariantId,
      quantity,
      properties: lineProperties,
    },
    properties: lineProperties,
    displayOptions: {
      type: typeLabel,
      colour: colourOption?.value || fallbackOption?.value || "Default",
      ...(brandingEntry ? { branding: brandingEntry.optionName } : {}),
      ...(packagingSelected ? { packaging: packagingName } : {}),
    },
    calculation: calculated,
  };
}

export async function cleanupExpiredConfiguredVariants({ admin, shop }) {
  const now = new Date();
  const expired = await prisma.temporaryConfiguredVariant.findMany({
    where: { shop, expiresAt: { lte: now } },
    orderBy: { createdAt: "asc" },
  });
  const targets = [...new Set(expired.map((row) => row.targetProductId))];
  let variantsDeleted = 0;
  let productsDeleted = 0;
  let recordsRemoved = 0;
  const errors = [];
  const items = [];

  for (const targetProductId of targets) {
    const rows = expired.filter(
      (row) => row.targetProductId === targetProductId,
    );
    const rowConfigurations = new Map(
      rows.map((row) => {
        try {
          return [row.id, JSON.parse(row.configurationJson)];
        } catch {
          return [row.id, {}];
        }
      }),
    );
    const persistentMaster = rows.some(
      (row) => rowConfigurations.get(row.id)?.persistentMasterProduct,
    );
    const dedicated = rows.every(
      (row) => row.targetProductId !== row.sourceProductId,
    );
    try {
      if (persistentMaster) {
        const deletableRows = rows.filter(
          (row) => !rowConfigurations.get(row.id)?.persistentCoreVariant,
        );
        for (let index = 0; index < deletableRows.length; index += 250) {
          const batch = deletableRows.slice(index, index + 250);
          const response = await admin.graphql(
            `#graphql
              mutation DeleteExpiredMasterConfiguredVariants($productId: ID!, $variantIds: [ID!]!) {
                productVariantsBulkDelete(productId: $productId, variantsIds: $variantIds) {
                  product { id }
                  userErrors { field message }
                }
              }
            `,
            {
              variables: {
                productId: targetProductId,
                variantIds: batch.map((row) => row.shopifyVariantId),
              },
            },
          );
          const json = await response.json();
          const mutationErrors = gqlErrors(
            json,
            (value) => value.data?.productVariantsBulkDelete,
          );
          if (mutationErrors.length) throw new Error(mutationErrors.join("; "));
        }
        const removed = await prisma.temporaryConfiguredVariant.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
        recordsRemoved += removed.count;
        variantsDeleted += deletableRows.length;
        rows.forEach((row) =>
          items.push({
            code: row.productCode,
            title: row.variantSku || "Temporary configured variant",
            status: "success",
            action: deletableRows.some((item) => item.id === row.id)
              ? "temporary_variant_deleted"
              : "expired_record_removed",
            targetProductId,
            shopifyVariantId: row.shopifyVariantId,
          }),
        );
        continue;
      }
      if (dedicated) {
        const activeCount = await prisma.temporaryConfiguredVariant.count({
          where: { shop, targetProductId, expiresAt: { gt: now } },
        });
        if (!activeCount) {
          const response = await admin.graphql(
            `#graphql
              mutation DeleteTemporaryConfigurationProduct($input: ProductDeleteInput!) {
                productDelete(input: $input) {
                  deletedProductId
                  userErrors { field message }
                }
              }
            `,
            { variables: { input: { id: targetProductId } } },
          );
          const json = await response.json();
          const mutationErrors = gqlErrors(
            json,
            (value) => value.data?.productDelete,
          );
          if (mutationErrors.length) throw new Error(mutationErrors.join("; "));
          productsDeleted += 1;
          const removed = await prisma.temporaryConfiguredVariant.deleteMany({
            where: { shop, targetProductId, expiresAt: { lte: now } },
          });
          recordsRemoved += removed.count;
          items.push({
            code: rows[0]?.productCode,
            title: "Temporary configuration product",
            status: "success",
            action: "temporary_product_deleted",
            targetProductId,
            recordsRemoved: removed.count,
          });
          continue;
        }
      }

      for (let index = 0; index < rows.length; index += 250) {
        const batch = rows.slice(index, index + 250);
        const response = await admin.graphql(
          `#graphql
            mutation DeleteExpiredConfiguredVariants($productId: ID!, $variantIds: [ID!]!) {
              productVariantsBulkDelete(productId: $productId, variantsIds: $variantIds) {
                product { id }
                userErrors { field message }
              }
            }
          `,
          {
            variables: {
              productId: targetProductId,
              variantIds: batch.map((row) => row.shopifyVariantId),
            },
          },
        );
        const json = await response.json();
        const mutationErrors = gqlErrors(
          json,
          (value) => value.data?.productVariantsBulkDelete,
        );
        if (mutationErrors.length) throw new Error(mutationErrors.join("; "));
      }
      const removed = await prisma.temporaryConfiguredVariant.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      recordsRemoved += removed.count;
      variantsDeleted += rows.length;
      rows.forEach((row) =>
        items.push({
          code: row.productCode,
          title: row.variantSku || "Temporary configured variant",
          status: "success",
          action: "temporary_variant_deleted",
          targetProductId,
          shopifyVariantId: row.shopifyVariantId,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cleanup failed";
      if (
        /product does not exist|product.*not found|was not found/i.test(message)
      ) {
        const removed = await prisma.temporaryConfiguredVariant.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
        recordsRemoved += removed.count;
        rows.forEach((row) =>
          items.push({
            code: row.productCode,
            title: row.variantSku || "Expired temporary record",
            status: "success",
            action: "orphan_record_removed",
            targetProductId,
          }),
        );
        continue;
      }
      errors.push({
        targetProductId,
        message,
      });
      items.push({
        code: rows[0]?.productCode,
        title: rows[0]?.variantSku || "Temporary configuration",
        status: "failed",
        action: "cleanup_failed",
        targetProductId,
        message,
      });
    }
  }
  return {
    expired: expired.length,
    variantsDeleted,
    productsDeleted,
    recordsRemoved,
    errors,
    items,
  };
}
