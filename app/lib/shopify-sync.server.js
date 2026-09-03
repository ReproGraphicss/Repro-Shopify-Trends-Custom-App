import { normalizeTrendsUrl } from "./trends-url";

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char],
  );

const shopifyErrorMessage = (
  error,
  fallback = "Shopify API request failed",
) => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const messages = [
      error.message,
      error.statusText,
      error.body?.message,
      error.response?.statusText,
    ].filter((value) => typeof value === "string" && value.trim());
    if (messages.length) return messages.join("; ");
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to the useful generic message below.
    }
  }
  return fallback;
};
const descriptionHtml = (product) =>
  `${product.description ? `<p>${escapeHtml(product.description)}</p>` : ""}${product.features?.length ? `<ul>${product.features.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}`;

export const shopifyStatusFromTrends = (product) => {
  const values = [product.status, product.active]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value).trim().toLowerCase());
  return values.some((value) =>
    ["draft", "inactive", "n", "no", "false", "0"].includes(value),
  )
    ? "DRAFT"
    : "ACTIVE";
};

const publicationCache = new WeakMap();

export async function getOnlineStorePublicationId(admin) {
  if (publicationCache.has(admin)) return publicationCache.get(admin);
  const response = await admin.graphql(`#graphql
    query TrendsOnlineStorePublication {
      publications(first: 20) {
        nodes { id supportsFuturePublishing }
      }
    }
  `);
  const json = await response.json();
  if (json.errors?.length)
    throw new Error(json.errors.map((error) => error.message).join("; "));
  const publication = (json.data?.publications?.nodes || []).find(
    (item) => item.supportsFuturePublishing,
  );
  if (!publication)
    throw new Error("The Online Store publication could not be found");
  publicationCache.set(admin, publication.id);
  return publication.id;
}

export async function publishProductToOnlineStore(admin, productId) {
  const publicationId = await getOnlineStorePublicationId(admin);
  const response = await admin.graphql(
    `#graphql
      mutation PublishTrendsProduct($id: ID!, $input: [PublicationInput!]!, $publicationId: ID!) {
        publishablePublish(id: $id, input: $input) {
          publishable { publishedOnPublication(publicationId: $publicationId) }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        id: productId,
        publicationId,
        input: [{ publicationId }],
      },
    },
  );
  const json = await response.json();
  const errors = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.publishablePublish?.userErrors || []).map(
      (error) => error.message,
    ),
  ];
  if (errors.length) throw new Error(errors.join("; "));
  return true;
}

const TRENDS_METAFIELD_DEFINITIONS = [
  ["PRODUCT", "product_configuration", "TRENDS product configuration", "json"],
  [
    "PRODUCT",
    "additional_product",
    "TRENDS additional product",
    "product_reference",
  ],
];

export const markedPrice = (value, markupPercent) =>
  Number((Number(value || 0) * (1 + Number(markupPercent) / 100)).toFixed(2));

export const brandingEntriesFor = (product) => {
  const additionalCosts = [
    ...new Map(
      (
        product.pricing?.flatMap((tier) => tier.additional_costs || []) || []
      ).map((cost, index) => [
        String(cost.id ?? `${cost.description}-${index}`),
        cost,
      ]),
    ).entries(),
  ];
  const usedNames = new Map();
  return additionalCosts.map(([costKey, cost]) => {
    const baseName =
      cost.branding_option || cost.description || `Branding ${costKey}`;
    const seen = usedNames.get(baseName) || 0;
    usedNames.set(baseName, seen + 1);
    const optionName = seen
      ? `${baseName} — ${cost.branding_area || seen + 1}`
      : baseName;
    const unitCodes = (cost.price_per_unit_charge_codes || [])
      .map((item) => item.price_per_unit_charge_code)
      .filter(Boolean);
    const unitSku = String(
      unitCodes[0] || `TRENDS-${product.code}-ADD-${costKey}`,
    );
    return {
      costKey,
      cost,
      optionName,
      unitSku,
      setupSku: `TRENDS-${product.code}-SETUP-${costKey}`,
      mode: /gift|packag|box|sleeve/i.test(
        `${cost.branding_option || ""} ${cost.branding_area || ""} ${cost.description || ""}`,
      )
        ? "gift_ready"
        : "branding",
    };
  });
};

const configurationFor = ({
  product,
  markupPercent,
  additionalMarkupPercent,
  brandingEntries,
  additionalProduct,
}) => {
  const variantBySku = new Map(
    (additionalProduct?.variants || []).map((variant) => [
      variant.sku,
      variant,
    ]),
  );
  const quantityBreaks = (product.pricing?.[0]?.prices || []).map((price) => ({
    quantity: Number(price.quantity),
    basePrice: Number(price.price),
    unitPrice: markedPrice(price.price, markupPercent),
  }));
  return {
    version: 2,
    source: "TRENDS",
    productCode: String(product.code),
    currency: "NZD",
    excludesGst: true,
    gstRate: 0.15,
    primaryPriceDescription:
      product.pricing?.[0]?.primary_price_description || "Unbranded",
    quantityBreaks,
    brandingMethods: brandingEntries.map((entry) => ({
      id: String(entry.costKey),
      mode: entry.mode,
      name: entry.optionName,
      description: entry.cost.description || "",
      area: entry.cost.branding_area || "",
      unitPrice: markedPrice(entry.cost.unit_price, additionalMarkupPercent),
      setupPrice: markedPrice(
        entry.cost.setup_price ?? entry.cost.setup,
        additionalMarkupPercent,
      ),
      unitChargeCode: entry.unitSku,
      setupChargeCode: entry.setupSku,
      unitVariantId: variantBySku.get(entry.unitSku)?.id || null,
      setupVariantId: variantBySku.get(entry.setupSku)?.id || null,
      quantityPrices: quantityBreaks.map((tier) => {
        const brandingUnitPrice = markedPrice(
          entry.cost.unit_price,
          additionalMarkupPercent,
        );
        return {
          quantity: tier.quantity,
          baseUnitPrice: tier.unitPrice,
          brandingUnitPrice,
          combinedUnitPrice: Number(
            (tier.unitPrice + brandingUnitPrice).toFixed(2),
          ),
        };
      }),
    })),
    packaging: product.packaging || "",
    specifications: product.additional_specifications || [],
    brandingOptions: product.branding_options || [],
    dimensions: product.dimensions || "",
    sizing: product.sizing || "",
    carton: product.carton || null,
    additionalMaterials: product.additional_materials || [],
    fullColour: product.full_colour ?? null,
    mixAndMatch: product.mix_and_match ?? null,
    pricingComment: product.pricing?.[0]?.pricing_comment || "",
    updatedAt: product.last_updated || null,
  };
};

export function calculateTrendsTierPrice({
  product,
  quantity,
  markupPercent,
  additionalMarkupPercent,
  brandingSku,
}) {
  const requestedQuantity = Math.max(1, Math.trunc(Number(quantity) || 1));
  const tiers = [...(product.pricing?.[0]?.prices || [])]
    .map((tier) => ({
      quantity: Math.max(1, Math.trunc(Number(tier.quantity) || 1)),
      basePrice: Number(tier.price || 0),
    }))
    .filter((tier) => tier.basePrice >= 0)
    .sort((a, b) => a.quantity - b.quantity);
  if (!tiers.length) throw new Error("TRENDS did not return quantity pricing");
  const tier =
    tiers.filter((item) => requestedQuantity >= item.quantity).pop() ||
    tiers[0];
  const baseUnitPrice = markedPrice(tier.basePrice, markupPercent);
  const brandingEntry = brandingSku
    ? brandingEntriesFor(product).find(
        (entry) => entry.unitSku === String(brandingSku),
      )
    : null;
  if (brandingSku && !brandingEntry)
    throw new Error(
      `Branding SKU ${brandingSku} is not available for this product`,
    );
  const brandingUnitPrice = brandingEntry
    ? markedPrice(brandingEntry.cost.unit_price, additionalMarkupPercent)
    : 0;
  const setupPrice = brandingEntry
    ? markedPrice(
        brandingEntry.cost.setup_price ?? brandingEntry.cost.setup,
        additionalMarkupPercent,
      )
    : 0;
  const unitPrice = Number((baseUnitPrice + brandingUnitPrice).toFixed(2));
  const subtotal = Number(
    (unitPrice * requestedQuantity + setupPrice).toFixed(2),
  );
  const regularUnitPrice = Number(
    (
      markedPrice(tiers[0].basePrice, markupPercent) + brandingUnitPrice
    ).toFixed(2),
  );
  return {
    quantity: requestedQuantity,
    appliedTierQuantity: tier.quantity,
    baseUnitPrice,
    brandingUnitPrice,
    unitPrice,
    setupPrice,
    subtotal,
    regularUnitPrice,
    discountPerUnit: Number(
      Math.max(0, regularUnitPrice - unitPrice).toFixed(2),
    ),
    discountTotal: Number(
      Math.max(0, (regularUnitPrice - unitPrice) * requestedQuantity).toFixed(
        2,
      ),
    ),
    tiers: tiers.map((item) => {
      const tierBaseUnitPrice = markedPrice(item.basePrice, markupPercent);
      const tierUnitPrice = Number(
        (tierBaseUnitPrice + brandingUnitPrice).toFixed(2),
      );
      return {
        quantity: item.quantity,
        baseUnitPrice: tierBaseUnitPrice,
        brandingUnitPrice,
        unitPrice: tierUnitPrice,
        discountPerUnit: Number(
          Math.max(0, regularUnitPrice - tierUnitPrice).toFixed(2),
        ),
      };
    }),
    branding: brandingEntry
      ? { sku: brandingEntry.unitSku, name: brandingEntry.optionName }
      : null,
  };
}

export async function ensureTrendsMetafieldDefinitions(admin) {
  const ownerTypes = [
    ...new Set(TRENDS_METAFIELD_DEFINITIONS.map(([ownerType]) => ownerType)),
  ];
  const requiredKeys = new Set(
    TRENDS_METAFIELD_DEFINITIONS.map(
      ([ownerType, key]) => `${ownerType}:${key}`,
    ),
  );
  const getDefinitions = async (ownerType) => {
    let response;
    try {
      response = await admin.graphql(
        `#graphql
        query TrendsMetafieldDefinitions($ownerType: MetafieldOwnerType!) {
          metafieldDefinitions(first: 250, ownerType: $ownerType) {
            nodes { id namespace key pinnedPosition }
          }
        }
      `,
        { variables: { ownerType } },
      );
    } catch (error) {
      throw new Error(
        shopifyErrorMessage(error, "Could not read metafield definitions"),
      );
    }
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    return (json.data?.metafieldDefinitions?.nodes || []).filter(
      (definition) => definition.namespace === "trends",
    );
  };

  const existing = new Set();
  for (const ownerType of ownerTypes) {
    for (const definition of await getDefinitions(ownerType))
      existing.add(`${ownerType}:${definition.key}`);
  }

  for (const [ownerType, key, name, type] of TRENDS_METAFIELD_DEFINITIONS) {
    if (existing.has(`${ownerType}:${key}`)) continue;
    let response;
    try {
      response = await admin.graphql(
        `#graphql
        mutation CreateTrendsMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id namespace key }
            userErrors { field message code }
          }
        }
      `,
        {
          variables: {
            definition: {
              ownerType,
              namespace: "trends",
              key,
              name,
              type,
            },
          },
        },
      );
    } catch (error) {
      throw new Error(shopifyErrorMessage(error, `Could not create ${name}`));
    }
    const json = await response.json();
    const errors = [
      ...(json.errors || []).map((error) => error.message),
      ...(json.data?.metafieldDefinitionCreate?.userErrors || [])
        .filter(
          (error) =>
            error.code !== "TAKEN" &&
            !/already exists|already in use/i.test(error.message),
        )
        .map((error) => error.message),
    ];
    if (errors.length) throw new Error(errors.join("; "));
  }

  // Shopify only shows pinned definitions in the product/variant editor.
  // Re-read after creation so definitions created concurrently (TAKEN) are
  // also found and pinned.
  for (const ownerType of ownerTypes) {
    for (const definition of await getDefinitions(ownerType)) {
      if (!requiredKeys.has(`${ownerType}:${definition.key}`)) continue;
      if (definition.pinnedPosition !== null) continue;
      // Pinning only controls visibility in Shopify Admin. It must never stop
      // product creation when a shop/API version refuses this optional step.
      try {
        const response = await admin.graphql(
          `#graphql
          mutation PinTrendsMetafieldDefinition($definitionId: ID!) {
            metafieldDefinitionPin(definitionId: $definitionId) {
              pinnedDefinition { id namespace key pinnedPosition }
              userErrors { field message code }
            }
          }
        `,
          { variables: { definitionId: definition.id } },
        );
        await response.json();
      } catch (error) {
        console.warn(
          `Could not pin TRENDS metafield ${definition.key}: ${shopifyErrorMessage(error)}`,
        );
      }
    }
  }
}

export async function getPrimaryLocation(admin, preferred) {
  if (preferred) return preferred;
  const response = await admin.graphql(`#graphql
    query TrendsLocations {
      locations(first: 20, includeInactive: false) {
        nodes { id fulfillsOnlineOrders }
      }
    }
  `);
  const locations = (await response.json()).data?.locations?.nodes || [];
  return (
    locations.find((item) => item.fulfillsOnlineOrders)?.id ||
    locations[0]?.id ||
    null
  );
}

export async function deleteTrendsShopifyProducts({ admin, items }) {
  const productIds = new Set(
    items
      .flatMap((item) => [
        item.shopifyProductId,
        item.shopifyAdditionalProductId,
      ])
      .filter(Boolean),
  );
  const handles = new Set();

  for (const item of items) {
    let product = null;
    try {
      product = JSON.parse(item.trendsDataJson || "null");
    } catch {
      product = null;
    }
    const productCode = product?.code || item.resolvedProductCode;
    if (!productCode) continue;
    handles.add(`trends-${productCode}`);
    handles.add(`trends-${productCode}-branding-options`);
    const costs = [
      ...new Map(
        (
          product?.pricing?.flatMap((tier) => tier.additional_costs || []) || []
        ).map((cost, index) => [
          String(cost.id ?? `${cost.description}-${index}`),
          cost,
        ]),
      ).entries(),
    ];
    for (const [costKey] of costs) {
      handles.add(`trends-${productCode}-additional-${costKey}`);
    }
  }

  for (const handle of handles) {
    const response = await admin.graphql(
      `#graphql
        query TrendsProductByHandle($identifier: ProductIdentifierInput!) {
          productByIdentifier(identifier: $identifier) { id handle }
        }
      `,
      { variables: { identifier: { handle } } },
    );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    const found = json.data?.productByIdentifier;
    if (found?.handle === handle) productIds.add(found.id);
  }

  let deleted = 0;
  for (const id of productIds) {
    const response = await admin.graphql(
      `#graphql
        mutation DeleteTrendsProduct($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors { field message }
          }
        }
      `,
      { variables: { input: { id } } },
    );
    const json = await response.json();
    const errors = [
      ...(json.errors || []).map((error) => error.message),
      ...(json.data?.productDelete?.userErrors || []).map(
        (error) => error.message,
      ),
    ];
    const missingOnly =
      errors.length > 0 &&
      errors.every((message) => /does not exist|not found/i.test(message));
    if (errors.length && !missingOnly) throw new Error(errors.join("; "));
    if (json.data?.productDelete?.deletedProductId) deleted++;
  }

  return deleted;
}

export async function syncTrendsProduct({
  admin,
  product,
  shopifyProductId = null,
  shopifyAdditionalProductId = null,
  markupPercent,
  additionalMarkupPercent,
  locationId,
  extraTags = [],
}) {
  const productStatus = shopifyStatusFromTrends(product);
  const prices = product.pricing?.[0]?.prices || [];
  if (!prices.length) throw new Error("TRENDS did not return a base price");
  const sellingPrice = (prices[0].price * (1 + markupPercent / 100)).toFixed(2);
  const stock = product.stock?.length
    ? product.stock
    : [{ stock_code: product.code, description: "Default", quantity: 0 }];
  const files = (product.images || [])
    .map((image) => ({
      originalSource: normalizeTrendsUrl(image.link),
      contentType: "IMAGE",
      alt: `${product.name || product.code} - ${image.caption || image.colour || "product image"}`.slice(
        0,
        512,
      ),
    }))
    .filter((file) => file.originalSource);
  const variants = stock.map((item) => {
    const image = product.images?.find(
      (entry) => String(entry.stock_code) === String(item.stock_code),
    );
    return {
      optionValues: [
        { optionName: "Colour", name: item.description || "Default" },
      ],
      sku: String(item.stock_code),
      price: sellingPrice,
      inventoryPolicy: "DENY",
      ...(locationId
        ? {
            inventoryQuantities: [
              {
                locationId,
                name: "available",
                quantity: Math.max(0, Math.trunc(item.quantity || 0)),
              },
            ],
          }
        : {}),
      ...(image
        ? {
            file: {
              originalSource: normalizeTrendsUrl(image.link),
              contentType: "IMAGE",
            },
          }
        : {}),
    };
  });
  const mainHandle = `trends-${product.code}`;
  const mainProduct = await runProductSet(admin, {
    identifier: shopifyProductId
      ? { id: shopifyProductId }
      : { handle: mainHandle },
    input: {
      ...(!shopifyProductId ? { handle: mainHandle } : {}),
      title: product.name || `TRENDS ${product.code}`,
      descriptionHtml: descriptionHtml(product),
      vendor: "TRENDS",
      productType: product.categories?.[0]?.name || "Promotional product",
      tags: [
        ...new Set([
          "TRENDS",
          ...(product.categories || []).map((category) => category.name),
          ...extraTags,
        ]),
      ],
      status: productStatus,
      files,
      productOptions: [
        {
          name: "Colour",
          position: 1,
          values: stock.map((item) => ({
            name: item.description || "Default",
          })),
        },
      ],
      variants,
    },
  });
  let additionalProduct = null;
  const brandingEntries = brandingEntriesFor(product);
  if (brandingEntries.length) {
    const brandingVariants = brandingEntries.flatMap((entry) => {
      const sharedOptions = [
        { optionName: "Branding method", name: entry.optionName },
      ];
      const unitVariant = {
        optionValues: [
          ...sharedOptions,
          { optionName: "Charge type", name: "Per unit" },
        ],
        sku: entry.unitSku,
        price: markedPrice(
          entry.cost.unit_price,
          additionalMarkupPercent,
        ).toFixed(2),
        inventoryPolicy: "CONTINUE",
      };
      const setupPrice = markedPrice(
        entry.cost.setup_price ?? entry.cost.setup,
        additionalMarkupPercent,
      );
      return setupPrice > 0
        ? [
            unitVariant,
            {
              optionValues: [
                ...sharedOptions,
                { optionName: "Charge type", name: "Setup fee" },
              ],
              sku: entry.setupSku,
              price: setupPrice.toFixed(2),
              inventoryPolicy: "CONTINUE",
            },
          ]
        : [unitVariant];
    });
    const handle = `trends-${product.code}-branding-options`;
    additionalProduct = await runProductSet(admin, {
      identifier: shopifyAdditionalProductId
        ? { id: shopifyAdditionalProductId }
        : { handle },
      input: {
        ...(!shopifyAdditionalProductId ? { handle } : {}),
        title: `${product.name || product.code} — Branding options`,
        vendor: "TRENDS",
        descriptionHtml:
          "<p>Select a branding method for this product. Each method has its own per-unit price and setup charge.</p>",
        productType: "Branding service",
        tags: ["TRENDS", "Branding options", `Source product ${product.code}`],
        status: productStatus,
        files,
        productOptions: [
          {
            name: "Branding method",
            position: 1,
            values: brandingEntries.map((entry) => ({
              name: entry.optionName,
            })),
          },
          {
            name: "Charge type",
            position: 2,
            values: [{ name: "Per unit" }, { name: "Setup fee" }],
          },
        ],
        variants: brandingVariants,
      },
    });
  }
  await setTrendsProductMetafields({
    admin,
    ownerId: mainProduct.id,
    additionalProductId: additionalProduct?.id,
    configuration: configurationFor({
      product,
      markupPercent,
      additionalMarkupPercent,
      brandingEntries,
      additionalProduct,
    }),
  });
  let publicationWarning = null;
  if (productStatus === "ACTIVE") {
    try {
      await publishProductToOnlineStore(admin, mainProduct.id);
    } catch (error) {
      publicationWarning = `Product synced, but Online Store publishing is pending: ${
        error instanceof Error ? error.message : "Publishing failed"
      }`;
    }
  }
  return {
    ...mainProduct,
    publicationWarning,
    additionalProducts: additionalProduct ? [additionalProduct] : [],
  };
}

export async function syncTrendsPriceAndInventory({
  admin,
  product,
  shopifyProductId,
  shopifyAdditionalProductId,
  markupPercent,
  additionalMarkupPercent,
  locationId,
}) {
  const prices = product.pricing?.[0]?.prices || [];
  if (!prices.length) throw new Error("TRENDS did not return a base price");

  const mainPrice = (
    Number(prices[0].price) *
    (1 + Number(markupPercent) / 100)
  ).toFixed(2);
  const mainStock = new Map(
    (product.stock || []).map((item) => [
      String(item.stock_code),
      Math.max(0, Math.trunc(Number(item.quantity) || 0)),
    ]),
  );

  const getVariants = async (productId) => {
    if (!productId) return [];
    const response = await admin.graphql(
      `#graphql
        query TrendsCronVariants($id: ID!) {
          product(id: $id) {
            variants(first: 250) {
              nodes { id sku inventoryItem { id } }
            }
          }
        }
      `,
      { variables: { id: productId } },
    );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    return json.data?.product?.variants?.nodes || [];
  };

  const updatePrices = async (productId, variants) => {
    if (!productId || !variants.length) return;
    const response = await admin.graphql(
      `#graphql
        mutation TrendsCronPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price }
            userErrors { field message code }
          }
        }
      `,
      { variables: { productId, variants } },
    );
    const json = await response.json();
    const errors = [
      ...(json.errors || []).map((error) => error.message),
      ...(json.data?.productVariantsBulkUpdate?.userErrors || []).map(
        (error) => error.message,
      ),
    ];
    if (errors.length) throw new Error(errors.join("; "));
  };

  const mainVariants = await getVariants(shopifyProductId);
  await updatePrices(
    shopifyProductId,
    mainVariants.map((variant) => ({ id: variant.id, price: mainPrice })),
  );

  if (locationId) {
    const quantities = mainVariants
      .filter(
        (variant) => variant.inventoryItem?.id && mainStock.has(variant.sku),
      )
      .map((variant) => ({
        inventoryItemId: variant.inventoryItem.id,
        locationId,
        quantity: mainStock.get(variant.sku),
      }));
    if (quantities.length) {
      const response = await admin.graphql(
        `#graphql
          mutation TrendsCronInventory($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              inventoryAdjustmentGroup { createdAt }
              userErrors { field message code }
            }
          }
        `,
        {
          variables: {
            input: {
              name: "available",
              reason: "correction",
              referenceDocumentUri: `trends://products/${product.code}`,
              ignoreCompareQuantity: true,
              quantities,
            },
          },
        },
      );
      const json = await response.json();
      const errors = [
        ...(json.errors || []).map((error) => error.message),
        ...(json.data?.inventorySetQuantities?.userErrors || []).map(
          (error) => error.message,
        ),
      ];
      if (errors.length) throw new Error(errors.join("; "));
    }
  }

  if (shopifyAdditionalProductId) {
    const additionalPrices = new Map();
    const brandingEntries = brandingEntriesFor(product);
    for (const entry of brandingEntries) {
      additionalPrices.set(
        entry.unitSku,
        markedPrice(entry.cost.unit_price, additionalMarkupPercent).toFixed(2),
      );
      const setupPrice = markedPrice(
        entry.cost.setup_price ?? entry.cost.setup,
        additionalMarkupPercent,
      );
      if (setupPrice > 0)
        additionalPrices.set(entry.setupSku, setupPrice.toFixed(2));
    }
    const additionalVariants = await getVariants(shopifyAdditionalProductId);
    await updatePrices(
      shopifyAdditionalProductId,
      additionalVariants
        .filter((variant) => additionalPrices.has(variant.sku))
        .map((variant) => ({
          id: variant.id,
          price: additionalPrices.get(variant.sku),
        })),
    );
    await setTrendsProductMetafields({
      admin,
      ownerId: shopifyProductId,
      additionalProductId: shopifyAdditionalProductId,
      configuration: configurationFor({
        product,
        markupPercent,
        additionalMarkupPercent,
        brandingEntries,
        additionalProduct: { variants: additionalVariants },
      }),
    });
  } else {
    await setTrendsProductMetafields({
      admin,
      ownerId: shopifyProductId,
      configuration: configurationFor({
        product,
        markupPercent,
        additionalMarkupPercent,
        brandingEntries: brandingEntriesFor(product),
        additionalProduct: null,
      }),
    });
  }

  return {
    variants: mainVariants.length,
    inventory: mainVariants.filter((variant) => mainStock.has(variant.sku))
      .length,
  };
}

async function setTrendsProductMetafields({
  admin,
  ownerId,
  additionalProductId,
  configuration,
}) {
  const response = await admin.graphql(
    `#graphql
      mutation LinkTrendsProduct($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value }
          userErrors { field message code }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: "trends",
            key: "product_configuration",
            type: "json",
            value: JSON.stringify(configuration),
          },
          ...(additionalProductId
            ? [
                {
                  ownerId,
                  namespace: "trends",
                  key: "additional_product",
                  type: "product_reference",
                  value: additionalProductId,
                },
              ]
            : []),
        ],
      },
    },
  );
  const json = await response.json();
  const errors = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.metafieldsSet?.userErrors || []).map(
      (error) => error.message,
    ),
  ];
  if (errors.length) throw new Error(errors.join("; "));
}

async function runProductSet(admin, variables) {
  const response = await admin.graphql(
    `#graphql
    mutation SyncTrendsProduct($identifier: ProductSetIdentifiers, $input: ProductSetInput!, $synchronous: Boolean!) {
      productSet(identifier: $identifier, input: $input, synchronous: $synchronous) {
        product {
          id title handle status
          variants(first: 250) { nodes { id sku title } }
        }
        userErrors { field message code }
      }
    }`,
    { variables: { ...variables, synchronous: true } },
  );
  const json = await response.json();
  const message = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.productSet?.userErrors || []).map(
      (error) => `${error.field?.join(".") || "product"}: ${error.message}`,
    ),
  ].join("; ");
  if (message) throw new Error(message);
  if (!json.data?.productSet?.product)
    throw new Error("Shopify did not return the synced product");
  const product = json.data.productSet.product;
  return { ...product, variants: product.variants?.nodes || [] };
}
