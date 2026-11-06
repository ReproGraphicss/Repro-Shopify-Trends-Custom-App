import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { normalizeTrendsUrl } from "./trends-url";
import {
  isPackagingCost,
  packagingDisplayName,
} from "./trends-cost-classification.js";
import { calculateFinalPricing } from "./trends-final-pricing.js";
import {
  isTrendsQuoteOnlyError,
  isTrendsQuoteOnlyProduct,
  requireTrendsBasePrices,
  trendsBasePricesFor,
  trendsBasePricingFor,
} from "./trends-base-pricing.js";
import {
  MANAGED_CORE_VARIANT_TARGET,
  planManagedCoreVariants,
  planSafeVariantDeletionPhases,
} from "./trends-variant-capacity.js";
import {
  indentConfigurationFor,
  indentTagsFor,
  withoutManagedIndentTags,
} from "./trends-indent.js";
import {
  getShippingConfiguration,
  getShippingProfiles,
} from "./shipping-compatibility.server.js";
import {
  buildTrendsSyncAudit,
  productMatchesTrendsIdentity,
} from "./trends-sync-audit.js";

export { getShippingConfiguration, getShippingProfiles };
export { isTrendsQuoteOnlyError, isTrendsQuoteOnlyProduct };

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

const stockVariantLabel = (item) =>
  String(item?.description || item?.colour || item?.color || "").trim();

const stockWithUniqueOptionLabels = (stock) => {
  const totals = new Map();
  for (const item of stock) {
    const label = stockVariantLabel(item) || "Default";
    const key = label.toLocaleLowerCase();
    totals.set(key, (totals.get(key) || 0) + 1);
  }
  const used = new Set();
  return stock.map((item, index) => {
    const label = stockVariantLabel(item) || "Default";
    const key = label.toLocaleLowerCase();
    let optionLabel = label;
    if ((totals.get(key) || 0) > 1) {
      const discriminator = String(item?.stock_code || index + 1).trim();
      optionLabel = `${label} (${discriminator})`;
    }
    let uniqueLabel = optionLabel;
    let suffix = 2;
    while (used.has(uniqueLabel.toLocaleLowerCase())) {
      uniqueLabel = `${optionLabel} ${suffix++}`;
    }
    used.add(uniqueLabel.toLocaleLowerCase());
    return { ...item, shopifyOptionLabel: uniqueLabel };
  });
};

const shopifyImageUrl = (value) => {
  const normalized = normalizeTrendsUrl(value);
  if (!normalized || /[\\\r\n\0]/.test(normalized)) return null;
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
      return null;
    return url.href;
  } catch {
    return null;
  }
};

const normalizedImageText = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const variantVisualParts = (item) => {
  const label = stockVariantLabel(item)
    .replace(/\([^)]*\bink\b[^)]*\)/gi, " ")
    .replace(/\b(?:black|blue|red|green|white)\s+ink\b/gi, " ")
    .trim();
  const parts = label.split(/[\/|]/).map(normalizedImageText).filter(Boolean);
  return {
    label: normalizedImageText(label),
    parts,
    preferred: parts.at(-1) || normalizedImageText(label),
  };
};

// TRENDS often links a colour image to only one stock SKU (for example the
// Black Ink SKU). Other ink variants share the same physical/barrel colour and
// must reuse that image. Exact SKU remains the strongest match; otherwise the
// visible product colour is matched against image captions/names/colour data.
const imageForStockVariant = (product, item) => {
  const images = (Array.isArray(product?.images) ? product.images : []).filter(
    (image) => shopifyImageUrl(image?.link),
  );
  if (!images.length) return null;
  const stockCode = String(item?.stock_code || item?.sku || "").trim();
  const exact = images.find(
    (image) =>
      stockCode && String(image?.stock_code || "").trim() === stockCode,
  );
  if (exact) return exact;

  const visual = variantVisualParts(item);
  if (!visual.label) return null;
  const ranked = images
    .map((image, index) => {
      const caption = normalizedImageText(image?.caption);
      const colour = normalizedImageText(image?.colour || image?.color);
      const name = normalizedImageText(image?.name);
      const searchable = `${caption} ${colour} ${name}`.trim();
      let score = 0;
      if (caption === visual.preferred) score += 120;
      if (caption === visual.label) score += 110;
      if (colour === visual.preferred) score += 75;
      if (colour === visual.label) score += 70;
      visual.parts.forEach((part, partIndex) => {
        const preferredBonus = partIndex === visual.parts.length - 1 ? 18 : 0;
        if (caption === part) score += 90 + preferredBonus;
        else if (caption && (caption.includes(part) || part.includes(caption)))
          score += 48 + preferredBonus;
        if (colour === part) score += 45 + preferredBonus;
        if (searchable.includes(part)) score += 18 + preferredBonus;
      });
      if (/^(main|side|back|detail)$/.test(caption)) score -= 80;
      return { image, score, index };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  return ranked[0]?.image || null;
};

const sellableStockFor = (product) => {
  const stock = Array.isArray(product?.stock) ? product.stock : [];
  const namedStock = stock.filter((item) => {
    const label = stockVariantLabel(item);
    return label && !/^\(?none\)?$/i.test(label);
  });
  const merchandiseStock = namedStock.filter(
    (item) =>
      !/\b(?:gift\s*(?:box|tube|bag|sleeve)|presentation\s*(?:box|tube)|optional\s*(?:box|tube)|packaging)\b/i.test(
        stockVariantLabel(item),
      ),
  );

  // Optional packaging can appear in the stock array next to the actual
  // merchandise. It belongs to the gift-ready configuration, not Colour.
  if (merchandiseStock.length) return merchandiseStock;
  // Keep packaging-looking rows when the product itself is packaging.
  return namedStock.length ? namedStock : stock;
};

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
const waitFor = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const isShopifyRetryableError = (error) =>
  /throttl|too many requests|status\s*429|code\s*429|currently being modified|try again later/i.test(
    shopifyErrorMessage(error),
  );
const withShopifyThrottleRetry = async (operation, maxAttempts = 7) => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isShopifyRetryableError(error) || attempt === maxAttempts)
        throw error;
      const backoff = [2000, 5000, 10000, 15000, 22000, 30000][attempt - 1];
      // Jitter prevents parallel workers from retrying against Shopify at the
      // same instant and immediately exhausting the restored API budget.
      await waitFor(backoff + Math.floor(Math.random() * 1500));
    }
  }
  throw lastError;
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

export async function getSalesChannels(admin) {
  const response = await admin.graphql(`#graphql
    query TrendsSalesChannels {
      publications(first: 100) {
        nodes {
          id
          autoPublish
          supportsFuturePublishing
          channels(first: 10) {
            nodes { id name handle }
          }
        }
      }
    }
  `);
  const json = await response.json();
  if (json.errors?.length)
    throw new Error(json.errors.map((error) => error.message).join("; "));
  return (json.data?.publications?.nodes || [])
    .flatMap((publication) =>
      (publication.channels?.nodes || []).map((channel) => ({
        id: channel.id,
        name: channel.name,
        handle: channel.handle,
        publicationId: publication.id,
        autoPublish: publication.autoPublish,
        supportsFuturePublishing: publication.supportsFuturePublishing,
      })),
    )
    .filter(
      (channel, index, channels) =>
        channels.findIndex(
          (item) => item.publicationId === channel.publicationId,
        ) === index,
    )
    .sort((a, b) =>
      a.supportsFuturePublishing
        ? -1
        : b.supportsFuturePublishing
          ? 1
          : a.name.localeCompare(b.name),
    );
}

export async function assignVariantsToShippingProfile({
  admin,
  profileId,
  variantIds,
  shippingConfiguration = null,
}) {
  if (!profileId) return 0;
  const resolvedShippingConfiguration =
    shippingConfiguration || (await getShippingConfiguration(admin));
  // Merchant-owned delivery profiles don't exist in the market-driven model.
  // Shopify Markets owns the applicable product/location shipping conditions.
  if (resolvedShippingConfiguration.marketDrivenShipping) return 0;
  const availableProfiles = resolvedShippingConfiguration.profiles;
  if (!availableProfiles.some((profile) => profile.id === profileId)) return 0;

  const requestedVariantIds = [...new Set((variantIds || []).filter(Boolean))];
  const uniqueVariantIds = [];
  for (let index = 0; index < requestedVariantIds.length; index += 250) {
    const ids = requestedVariantIds.slice(index, index + 250);
    const response = await admin.graphql(
      `#graphql
        query ValidateTrendsShippingVariants($ids: [ID!]!) {
          nodes(ids: $ids) { id __typename }
        }
      `,
      { variables: { ids } },
    );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    uniqueVariantIds.push(
      ...(json.data?.nodes || [])
        .filter((node) => node?.__typename === "ProductVariant")
        .map((node) => node.id),
    );
  }
  if (!uniqueVariantIds.length) return 0;
  for (let index = 0; index < uniqueVariantIds.length; index += 250) {
    const response = await admin.graphql(
      `#graphql
        mutation AssignTrendsShippingProfile($id: ID!, $profile: DeliveryProfileInput!) {
          deliveryProfileUpdate(id: $id, profile: $profile) {
            profile { id name }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          id: profileId,
          profile: {
            variantsToAssociate: uniqueVariantIds.slice(index, index + 250),
          },
        },
      },
    );
    const json = await response.json();
    const errors = [
      ...(json.errors || []).map((error) => error.message),
      ...(json.data?.deliveryProfileUpdate?.userErrors || []).map(
        (error) => error.message,
      ),
    ];
    if (errors.length) throw new Error(errors.join("; "));
  }
  return uniqueVariantIds.length;
}

export async function assignProductsToShippingProfile({
  admin,
  profileId,
  productIds,
}) {
  if (!profileId) return 0;
  const shippingConfiguration = await getShippingConfiguration(admin);
  if (shippingConfiguration.marketDrivenShipping) return 0;
  const variantIds = [];
  for (const productId of [...new Set((productIds || []).filter(Boolean))]) {
    let after = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const response = await admin.graphql(
        `#graphql
          query TrendsShippingProfileVariants($id: ID!, $after: String) {
            product(id: $id) {
              variants(first: 250, after: $after) {
                nodes { id }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        `,
        { variables: { id: productId, after } },
      );
      const json = await response.json();
      if (json.errors?.length)
        throw new Error(json.errors.map((error) => error.message).join("; "));
      const variants = json.data?.product?.variants;
      variantIds.push(...(variants?.nodes || []).map((variant) => variant.id));
      hasNextPage = Boolean(variants?.pageInfo?.hasNextPage);
      after = variants?.pageInfo?.endCursor || null;
      if (hasNextPage && !after)
        throw new Error("Shopify did not return the next variant page cursor");
    }
  }
  return assignVariantsToShippingProfile({
    admin,
    profileId,
    variantIds,
    shippingConfiguration,
  });
}

export async function getProductTemplates(admin) {
  const themeResponse = await admin.graphql(`#graphql
    query TrendsPublishedTheme {
      themes(first: 1, roles: [MAIN]) {
        nodes { id name }
      }
    }
  `);
  const themeJson = await themeResponse.json();
  if (themeJson.errors?.length)
    throw new Error(themeJson.errors.map((error) => error.message).join("; "));
  const theme = themeJson.data?.themes?.nodes?.[0];
  if (!theme) return { themeId: null, themeName: "", templates: [""] };

  const filenames = [];
  let after = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query TrendsProductTemplateFiles($themeId: ID!, $after: String) {
          theme(id: $themeId) {
            files(
              first: 50
              after: $after
              filenames: ["templates/product*"]
            ) {
              nodes { filename }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      { variables: { themeId: theme.id, after } },
    );
    const json = await response.json();
    const files = json.data?.theme?.files;
    const errors = (json.errors || []).map((error) => error.message);
    if (errors.length) throw new Error(errors.join("; "));
    filenames.push(...(files?.nodes || []).map((file) => file.filename));
    hasNextPage = Boolean(files?.pageInfo?.hasNextPage);
    after = files?.pageInfo?.endCursor || null;
    if (hasNextPage && !after)
      throw new Error("Shopify did not return the next template page cursor");
  }

  const templates = filenames
    .map(
      (filename) =>
        filename.match(
          /^templates\/product(?:\.([^/]+))?\.(?:json|liquid)$/i,
        )?.[1] || "",
    )
    .filter((suffix, index, values) => values.indexOf(suffix) === index)
    .sort((a, b) => a.localeCompare(b));
  if (!templates.includes("")) templates.unshift("");
  return {
    themeId: theme?.id || null,
    themeName: theme?.name || "",
    templates,
  };
}

const publicationMutation = async (
  admin,
  mutation,
  productId,
  publicationIds,
) => {
  if (!publicationIds.length) return;
  const response = await admin.graphql(
    `#graphql
      mutation UpdateTrendsMarketAvailability($id: ID!, $input: [PublicationInput!]!) {
        ${mutation}(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        id: productId,
        input: publicationIds.map((publicationId) => ({ publicationId })),
      },
    },
  );
  const json = await response.json();
  const errors = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.[mutation]?.userErrors || []).map((error) => error.message),
  ];
  if (errors.length) throw new Error(errors.join("; "));
};

export async function applyProductTemplateAndSalesChannels({
  admin,
  productId,
  templateSuffix,
  selectedPublicationIds = null,
  salesChannels = null,
}) {
  const response = await admin.graphql(
    `#graphql
      mutation UpdateTrendsProductTemplate($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id templateSuffix }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        product: {
          id: productId,
          templateSuffix: String(templateSuffix || "").trim() || null,
        },
      },
    },
  );
  const json = await response.json();
  const templateErrors = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.productUpdate?.userErrors || []).map(
      (error) => error.message,
    ),
  ];
  if (templateErrors.length) throw new Error(templateErrors.join("; "));

  const availableChannels = salesChannels || (await getSalesChannels(admin));
  const selected = Array.isArray(selectedPublicationIds)
    ? selectedPublicationIds
    : availableChannels
        .filter((channel) => channel.supportsFuturePublishing)
        .map((channel) => channel.publicationId);
  const availableIds = [
    ...new Set(availableChannels.map((channel) => channel.publicationId)),
  ];
  const selectedIds = availableIds.filter((id) => selected.includes(id));
  const unselectedIds = availableIds.filter((id) => !selected.includes(id));
  await publicationMutation(
    admin,
    "publishablePublish",
    productId,
    selectedIds,
  );
  await publicationMutation(
    admin,
    "publishableUnpublish",
    productId,
    unselectedIds,
  );
}

export async function updateShopifyProductStatus({ admin, productId, status }) {
  const normalizedStatus = String(status || "").toUpperCase();
  if (!productId) throw new Error("Shopify product ID is required");
  if (!["ACTIVE", "DRAFT"].includes(normalizedStatus))
    throw new Error("Product status must be ACTIVE or DRAFT");

  const response = await admin.graphql(
    `#graphql
      mutation UpdateTrendsProductStatus($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id status }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        product: { id: productId, status: normalizedStatus },
      },
    },
  );
  const json = await response.json();
  const errors = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.productUpdate?.userErrors || []).map(
      (error) => error.message,
    ),
  ];
  if (errors.length) throw new Error(errors.join("; "));
  return json.data?.productUpdate?.product || null;
}

const TRENDS_METAFIELD_DEFINITIONS = [
  [
    "PRODUCT",
    "trends",
    "product_configuration",
    "TRENDS product configuration",
    "json",
  ],
];

export const markedPrice = (value, markupPercent) =>
  Number((Number(value || 0) * (1 + Number(markupPercent) / 100)).toFixed(2));

const costDescription = (cost) =>
  `${cost?.type || ""} ${cost?.branding_option || ""} ${cost?.branding_area || ""} ${cost?.description || ""} ${cost?.name || ""} ${cost?.title || ""} ${cost?.label || ""} ${cost?.additional_cost_description || ""} ${cost?.cost_description || ""} ${cost?.price_per_order_charge_code || ""}`.trim();

const isShippingCost = (cost) =>
  /shipping|freight|delivery|handling|transit/i.test(costDescription(cost));

export const shippingOptionsFor = (product) => {
  const baseTiers = [];
  const directOptions = new Map();
  for (const pricing of product.pricing || []) {
    const fallbackQuantities = (pricing.prices || [])
      .map((price) => Math.max(1, Math.trunc(Number(price.quantity) || 1)))
      .filter(Number.isFinite);
    for (const [index, cost] of (pricing.additional_costs || []).entries()) {
      if (!isShippingCost(cost)) continue;
      const id = String(cost.id ?? cost.code ?? costDescription(cost) ?? index);
      const name =
        cost.branding_option ||
        cost.description ||
        cost.branding_area ||
        "Shipping and handling";
      const service = /overnight|express|priority/i.test(name)
        ? "overnight"
        : /economy|standard/i.test(name)
          ? "economy"
          : "standard";
      const quantity = Math.max(
        1,
        Math.trunc(
          Number(
            cost.quantity ??
              cost.minimum_quantity ??
              pricing.quantity ??
              fallbackQuantities[0] ??
              1,
          ) || 1,
        ),
      );
      const charge = Number(
        Number(
          cost.freight_surcharge ??
            cost.shipping_charge ??
            cost.per_order_price ??
            cost.per_order ??
            cost.order_price ??
            cost.charge ??
            cost.amount ??
            cost.price ??
            cost.unit_price ??
            cost.setup_price ??
            cost.setup ??
            0,
        ).toFixed(2),
      );
      const option = directOptions.get(id) || {
        id,
        name,
        service,
        includedInUnitPrice: true,
        perDeliveryAddress: true,
        tiers: [],
      };
      option.tiers.push({ quantity, charge });
      directOptions.set(id, option);
      if (service !== "overnight") baseTiers.push({ quantity, charge });
    }
  }

  const overnightSurcharges = [];
  const visit = (value, path = []) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    const context = `${path.join(" ")} ${costDescription(value)} ${value.service || ""} ${value.method || ""}`;
    if (/overnight|express|priority/i.test(context)) {
      const quantity = Math.trunc(
        Number(
          value.quantity ??
            value.qty ??
            value.minimum_quantity ??
            value.min_quantity ??
            value.break_quantity,
        ),
      );
      const charge = Number(
        value.freight_surcharge ??
          value.surcharge ??
          value.shipping_charge ??
          value.charge ??
          value.amount ??
          value.price,
      );
      if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(charge))
        overnightSurcharges.push({ quantity, charge });

      const quantities =
        value.quantities || value.quantity_breaks || value.quantityBreaks;
      const charges =
        value.charges ||
        value.prices ||
        value.surcharges ||
        value.freight_surcharges;
      if (Array.isArray(quantities) && Array.isArray(charges)) {
        quantities.forEach((item, index) => {
          const tierQuantity = Math.trunc(Number(item?.quantity ?? item));
          const tierCharge = Number(
            charges[index]?.charge ??
              charges[index]?.price ??
              charges[index]?.amount ??
              charges[index],
          );
          if (
            Number.isFinite(tierQuantity) &&
            tierQuantity > 0 &&
            Number.isFinite(tierCharge)
          )
            overnightSurcharges.push({
              quantity: tierQuantity,
              charge: tierCharge,
            });
        });
      }
    }
    Object.entries(value).forEach(([key, item]) => visit(item, [...path, key]));
  };
  visit(product);

  const normalizeTiers = (tiers) =>
    [
      ...new Map(
        tiers
          .filter(
            (tier) =>
              Number.isFinite(tier.quantity) && Number.isFinite(tier.charge),
          )
          .map((tier) => [tier.quantity, tier]),
      ).values(),
    ].sort((a, b) => a.quantity - b.quantity);
  const normalizedBaseTiers = normalizeTiers(baseTiers);
  const baseChargeFor = (quantity) =>
    normalizedBaseTiers.filter((tier) => quantity >= tier.quantity).pop()
      ?.charge ??
    normalizedBaseTiers[0]?.charge ??
    0;
  const options = [...directOptions.values()].map((option) => ({
    ...option,
    id: option.service === "overnight" ? "overnight" : "economy",
    service: option.service === "overnight" ? "overnight" : "economy",
    name:
      option.service === "overnight"
        ? "Overnight (NZC)"
        : "Economy shipping and handling",
    tiers: normalizeTiers(option.tiers),
  }));
  if (normalizedBaseTiers.length) {
    const economy = {
      id: "economy",
      name: "Economy shipping and handling",
      service: "economy",
      includedInUnitPrice: true,
      perDeliveryAddress: true,
      tiers: normalizedBaseTiers,
    };
    const existingIndex = options.findIndex((x) => x.service === "economy");
    if (existingIndex >= 0) options[existingIndex] = economy;
    else options.unshift(economy);
  }
  const normalizedSurcharges = normalizeTiers(overnightSurcharges);
  if (normalizedSurcharges.length) {
    const overnight = {
      id: "overnight",
      name: "Overnight (NZC)",
      service: "overnight",
      includedInUnitPrice: true,
      perDeliveryAddress: true,
      tiers: normalizedSurcharges.map((tier) => ({
        quantity: tier.quantity,
        charge: Number((baseChargeFor(tier.quantity) + tier.charge).toFixed(2)),
        baseCharge: baseChargeFor(tier.quantity),
        surcharge: tier.charge,
      })),
    };
    const existingIndex = options.findIndex((x) => x.service === "overnight");
    if (existingIndex >= 0) options[existingIndex] = overnight;
    else options.push(overnight);
  }
  return options.filter(
    (option, index, list) =>
      list.findIndex((item) => item.service === option.service) === index,
  );
};

const selectedShippingFor = (product, quantity, shippingService) => {
  const options = shippingOptionsFor(product);
  if (!options.length || String(shippingService || "").toLowerCase() === "none")
    return { selected: null, options };
  const requested = String(shippingService || "")
    .trim()
    .toLowerCase();
  const selected =
    options.find(
      (option) =>
        option.id.toLowerCase() === requested ||
        option.service === requested ||
        option.name.toLowerCase() === requested,
    ) ||
    options.find((option) => option.service === "economy") ||
    options.find((option) => option.service === "standard") ||
    options[0];
  const tier = selected.tiers
    .filter((item) => quantity >= item.quantity)
    .pop() ||
    selected.tiers[0] || { quantity: 1, charge: 0 };
  return {
    selected: {
      id: selected.id,
      name: selected.name,
      service: selected.service,
      appliedTierQuantity: tier.quantity,
      charge: tier.charge,
      baseCharge: Number(tier.baseCharge ?? tier.charge ?? 0),
      surcharge: Number(tier.surcharge ?? 0),
      includedInUnitPrice: true,
      perDeliveryAddress: true,
    },
    options,
  };
};

export const brandingEntriesFor = (product) => {
  const additionalCosts = [
    ...new Map(
      (product.pricing?.flatMap((tier) => tier.additional_costs || []) || [])
        .filter((cost) => !isShippingCost(cost))
        .map((cost, index) => [
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
      mode: isPackagingCost(cost) ? "gift_ready" : "branding",
    };
  });
};

const configurationFor = ({
  product,
  markupPercent,
  fixedShippingAmount = 15,
  brandingEntries,
  customCorporatePackEnabled = false,
}) => {
  const artworkTemplates = [];
  const templateUrls = new Set();
  const collectArtworkTemplates = (value, path = []) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        collectArtworkTemplates(item, [...path, String(index)]),
      );
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.entries(value).forEach(([key, child]) => {
      const childPath = [...path, key];
      if (
        typeof child === "string" &&
        /\.pdf(?:[?#].*)?$/i.test(child.trim())
      ) {
        const url = normalizeTrendsUrl(child);
        if (!url || templateUrls.has(url)) return;
        templateUrls.add(url);
        const filename = decodeURIComponent(
          url.split("/").pop()?.split(/[?#]/)[0] || "artwork-template.pdf",
        );
        const siblingUpdatedAt =
          value[`${key}_last_updated`] ||
          value[`${key}LastUpdated`] ||
          value.last_updated ||
          null;
        artworkTemplates.push({
          id: childPath.join("."),
          type: /wire/i.test(key) ? "product_wire" : "artwork_template",
          name: /product[_\s-]*wire/i.test(key)
            ? "Product Branding Template"
            : filename.replace(/\.pdf$/i, "").replace(/[_-]+/g, " "),
          filename,
          url,
          lastUpdated:
            siblingUpdatedAt || product.product_wire_last_updated || null,
        });
      }
      collectArtworkTemplates(child, childPath);
    });
  };
  collectArtworkTemplates(product);
  const classifiedTemplates = artworkTemplates.map((template) => {
    const sourceField =
      template.id
        .split(".")
        .filter((part) => !/^\d+$/.test(part))
        .pop() || "template";
    const sourceText = `${sourceField} ${template.filename} ${template.type}`;
    let category;
    let baseName;
    if (/personali[sz]ation|personalized|personalised/i.test(sourceText)) {
      category = "personalisation";
      baseName = "Personalisation Template";
    } else if (/branding|product[_\s-]*wire|artwork/i.test(sourceText)) {
      category = "branding";
      baseName = "Branding Template";
    } else {
      const readableName = sourceField
        .replace(/(?:_?pdf|_?url|_?link|_?document)$/i, "")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
        .trim();
      category = sourceField
        .replace(/(?:_?pdf|_?url|_?link|_?document)$/i, "")
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
      baseName = /template$/i.test(readableName)
        ? readableName
        : `${readableName || "Product"} Template`;
    }
    return { ...template, category, baseName, sourceField };
  });
  const templateNameTotals = classifiedTemplates.reduce(
    (totals, template) => ({
      ...totals,
      [template.baseName]: (totals[template.baseName] || 0) + 1,
    }),
    {},
  );
  const templateNameIndexes = {};
  const templates = classifiedTemplates.map((template, index) => {
    templateNameIndexes[template.baseName] =
      (templateNameIndexes[template.baseName] || 0) + 1;
    const nameIndex = templateNameIndexes[template.baseName];
    return {
      id: `template-${index + 1}`,
      name:
        templateNameTotals[template.baseName] > 1
          ? `${template.baseName} ${nameIndex}`
          : template.baseName,
      type: "pdf",
      category: template.category,
      sourceType: template.sourceField,
      filename: template.filename,
      url: template.url,
      lastUpdated: template.lastUpdated,
    };
  });
  const basePricing = trendsBasePricingFor(product);
  const quantityBreaks = trendsBasePricesFor(product).map((price) => ({
    quantity: Number(price.quantity),
    unitPrice: Number(price.price || 0),
  }));
  const methodConfiguration = (entry, priceField) => ({
    id: String(entry.costKey),
    name: entry.optionName,
    description: entry.cost.description || "",
    area: entry.cost.branding_area || "",
    unitPrice: Number(entry.cost.unit_price || 0),
    setupPrice: Number(entry.cost.setup_price ?? entry.cost.setup ?? 0),
    unitChargeCode: entry.unitSku,
    setupChargeCode: entry.setupSku,
    quantityPrices: quantityBreaks.map((tier) => {
      const additionalUnitPrice = Number(entry.cost.unit_price || 0);
      return {
        quantity: tier.quantity,
        baseUnitPrice: tier.unitPrice,
        [priceField]: additionalUnitPrice,
        combinedUnitPrice: Number(
          (tier.unitPrice + additionalUnitPrice).toFixed(2),
        ),
      };
    }),
  });
  const brandingMethods = brandingEntries
    .filter((entry) => entry.mode === "branding")
    .map((entry) => methodConfiguration(entry, "brandingUnitPrice"));
  const paidPackagingMethods = brandingEntries
    .filter((entry) => entry.mode === "gift_ready")
    .map((entry) => methodConfiguration(entry, "packagingUnitPrice"));
  const includedPackagingText = [
    product.packaging,
    ...(product.features || []),
    ...(product.additional_specifications || []).flatMap((item) => [
      item.specification,
      item.description,
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  const hasStandardPackaging =
    Boolean(String(product.packaging || "").trim()) ||
    /(?:gift|presentation|individual|standard)\s*(?:box|packag|carton)|(?:box|packag)\s*\(included\)|included\s*(?:box|packag)/i.test(
      includedPackagingText,
    );
  const packagingImages = (product.images || [])
    .map((image) => ({
      url: String(image.link || "")
        .trim()
        .replace(/^\/\//, "https://"),
      caption: String(image.caption || image.name || "").trim(),
    }))
    .filter((image) => image.url);
  const standardPackagingImage =
    packagingImages.find(
      (image) =>
        /gift\s*box|packag|presentation/i.test(image.caption) &&
        !/sleeve|tube|branding|print/i.test(image.caption),
    )?.url || null;
  const premiumPackagingImage = (method) => {
    const methodText = `${method.name} ${method.area} ${method.description}`;
    const exactType = /tube/i.test(methodText)
      ? /tube/i
      : /sleeve/i.test(methodText)
        ? /sleeve/i
        : /gift\s*box|packag/i;
    return (
      packagingImages.find((image) => exactType.test(image.caption))?.url ||
      null
    );
  };
  const packagingMethods = [
    ...(hasStandardPackaging
      ? [
          {
            id: "standard",
            type: "standard",
            name: "Standard Packaging",
            description: product.packaging || "Included with this product",
            included: true,
            unitPrice: 0,
            setupPrice: 0,
            action: "select",
            methodId: null,
            image: standardPackagingImage,
          },
        ]
      : []),
    ...paidPackagingMethods
      .filter(
        (method) =>
          !/personalisation\s+surcharge|personalization\s+surcharge/i.test(
            `${method.name} ${method.description}`,
          ),
      )
      .map((method) => ({
        id: method.id,
        type: "premium",
        name: packagingDisplayName(method),
        description: method.area || method.description || method.name,
        included: false,
        unitPrice: method.unitPrice,
        setupPrice: method.setupPrice,
        unitChargeCode: method.unitChargeCode,
        setupChargeCode: method.setupChargeCode,
        action: "select",
        methodId: method.id,
        image: premiumPackagingImage(method),
      })),
    ...(customCorporatePackEnabled
      ? [
          {
            id: "custom-corporate-pack",
            type: "custom",
            name: "Custom Corporate Pack",
            description: "Custom branded packaging made to your requirements",
            included: false,
            unitPrice: 0,
            setupPrice: 0,
            action: "select",
            methodId: "custom-corporate-pack",
            image: null,
          },
        ]
      : []),
  ];
  const stock = (Array.isArray(product.stock) ? product.stock : []).map(
    (item) => ({ ...item }),
  );
  return {
    version: 12,
    source: "TRENDS",
    productCode: String(product.code),
    stock,
    stockSummary: {
      variantCount: stock.length,
      totalAvailable: stock.reduce(
        (total, item) => total + Math.max(0, Number(item.quantity) || 0),
        0,
      ),
      nextShipmentTotal: stock.reduce(
        (total, item) => total + Math.max(0, Number(item.next_shipment) || 0),
        0,
      ),
    },
    stockUpdatedAt: new Date().toISOString(),
    currency: "NZD",
    markupPercent: Number(markupPercent || 0),
    fixedShippingAmount: Number(fixedShippingAmount || 0),
    primaryPriceDescription:
      basePricing?.primary_price_description || "Unbranded",
    quantityBreaks,
    brandingMethods,
    packagingMethods,
    shippingOptions: shippingOptionsFor(product),
    packaging: product.packaging || "",
    specifications: product.additional_specifications || [],
    brandingOptions: product.branding_options || [],
    templates,
    dimensions: product.dimensions || "",
    sizing: product.sizing || "",
    carton: product.carton || null,
    additionalMaterials: product.additional_materials || [],
    fullColour: product.full_colour ?? null,
    mixAndMatch: product.mix_and_match ?? null,
    pricingComment: basePricing?.pricing_comment || "",
    updatedAt: product.last_updated || null,
  };
};

export function calculateTrendsTierPrice({
  product,
  quantity,
  markupPercent,
  brandingSku,
  additionalSkus,
  additionalSelections,
  shippingService,
  fixedShippingAmount = 15,
}) {
  const requestedQuantity = Math.max(1, Math.trunc(Number(quantity) || 1));
  const tiers = [...trendsBasePricesFor(product)]
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
  const baseUnitPrice = Number(tier.basePrice || 0);
  const requestedAdditionalSelections = [
    ...(Array.isArray(additionalSelections) ? additionalSelections : []),
    ...(Array.isArray(additionalSkus)
      ? additionalSkus.map((sku) => ({ sku, quantity: requestedQuantity }))
      : []),
    ...(brandingSku ? [{ sku: brandingSku, quantity: requestedQuantity }] : []),
  ].reduce((items, selection) => {
    const sku = String(selection?.sku || "").trim();
    if (!sku || items.some((item) => item.sku === sku)) return items;
    const selectionQuantity = Math.trunc(Number(selection.quantity));
    if (
      !Number.isFinite(selectionQuantity) ||
      selectionQuantity < 1 ||
      selectionQuantity > 100000
    )
      throw new Error(`Quantity for additional-cost SKU ${sku} is invalid`);
    const directUnitPrice = Number(selection?.unitPrice);
    const directSetupPrice = Number(selection?.setupPrice || 0);
    items.push({
      ...selection,
      sku,
      quantity: selectionQuantity,
      unitPrice: Number.isFinite(directUnitPrice) ? directUnitPrice : null,
      setupPrice: Number.isFinite(directSetupPrice) ? directSetupPrice : 0,
    });
    return items;
  }, []);
  const availableEntries = brandingEntriesFor(product);
  const additionalEntries = requestedAdditionalSelections.map((selection) => {
    if (selection.unitPrice !== null) {
      return {
        entry: {
          costKey: selection.id || selection.sku,
          optionName: selection.name || selection.sku,
          mode: selection.mode || "gift_ready",
          unitSku: selection.sku,
          cost: {
            unit_price: selection.unitPrice,
            setup_price: selection.setupPrice,
          },
        },
        quantity: selection.quantity,
      };
    }
    const entry = availableEntries.find(
      (candidate) => candidate.unitSku === selection.sku,
    );
    if (!entry)
      throw new Error(
        `Additional-cost SKU ${selection.sku} is not available for this product`,
      );
    return { entry, quantity: selection.quantity };
  });
  const additionalCosts = additionalEntries.map(({ entry, quantity }) => ({
    id: String(entry.costKey),
    name: entry.optionName,
    mode: entry.mode,
    sku: entry.unitSku,
    quantity,
    unitPrice: Number(entry.cost.unit_price || 0),
    setupPrice: Number(entry.cost.setup_price ?? entry.cost.setup ?? 0),
  }));
  const shipping = selectedShippingFor(
    product,
    requestedQuantity,
    shippingService,
  );
  const finalPricing = calculateFinalPricing({
    baseUnitPrice,
    quantity: requestedQuantity,
    additionalCosts,
    fixedShippingAmount,
    markupPercent,
  });
  const {
    brandingUnitPrice,
    packagingUnitPrice,
    setupPrice,
    shippingCharge,
    rawSubtotal,
    markupAmount,
    subtotal,
    unitPrice,
  } = finalPricing;
  const regularUnitPrice = unitPrice;
  return {
    quantity: requestedQuantity,
    appliedTierQuantity: tier.quantity,
    baseUnitPrice,
    brandingUnitPrice,
    packagingUnitPrice,
    unitPrice,
    setupPrice,
    shippingCharge,
    shipping: {
      id: "fixed",
      service: "fixed",
      name: "Fixed shipping and handling",
      charge: shippingCharge,
    },
    shippingOptions: shipping.options,
    additionalCosts,
    rawSubtotal,
    markupPercent: Number(markupPercent || 0),
    markupAmount,
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
      const tierBaseUnitPrice = Number(item.basePrice || 0);
      const tierRawSubtotal =
        tierBaseUnitPrice * item.quantity +
        additionalCosts.reduce(
          (total, cost) =>
            total + cost.unitPrice * item.quantity + cost.setupPrice,
          0,
        ) +
        shippingCharge;
      const tierUnitPrice = Number(
        (
          (tierRawSubtotal * (1 + Number(markupPercent || 0) / 100)) /
          item.quantity
        ).toFixed(2),
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
    branding: additionalCosts.find((item) => item.mode === "branding") || null,
  };
}

export async function updateTrendsProductConfiguration({
  admin,
  productId,
  product,
  markupPercent,
  fixedShippingAmount = 15,
  customCorporatePackEnabled = false,
}) {
  if (!productId) throw new Error("Shopify product was not found");
  return withShopifyThrottleRetry(() =>
    setTrendsProductMetafields({
      admin,
      ownerId: productId,
      configuration: configurationFor({
        product,
        markupPercent,
        fixedShippingAmount,
        brandingEntries: brandingEntriesFor(product),
        customCorporatePackEnabled,
      }),
    }),
  );
}

export async function ensureTrendsMetafieldDefinitions(admin) {
  const ownerTypes = [
    ...new Set(TRENDS_METAFIELD_DEFINITIONS.map(([ownerType]) => ownerType)),
  ];
  const requiredKeys = new Set(
    TRENDS_METAFIELD_DEFINITIONS.map(
      ([ownerType, namespace, key]) => `${ownerType}:${namespace}:${key}`,
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
    return json.data?.metafieldDefinitions?.nodes || [];
  };

  const existing = new Set();
  const legacyDefinitions = [];
  for (const ownerType of ownerTypes) {
    for (const definition of await getDefinitions(ownerType)) {
      existing.add(`${ownerType}:${definition.namespace}:${definition.key}`);
      if (
        ownerType === "PRODUCT" &&
        ((definition.namespace === "trends" &&
          definition.key === "additional_product") ||
          (definition.namespace === "custom" &&
            [
              "custom_configured_variant",
              "custom_variants_configuration",
            ].includes(definition.key)))
      )
        legacyDefinitions.push(definition);
    }
  }

  for (const definition of legacyDefinitions) {
    const response = await admin.graphql(
      `#graphql
        mutation DeleteLegacyTrendsMetafieldDefinition($id: ID!, $deleteAll: Boolean!) {
          metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: $deleteAll) {
            deletedDefinitionId
            userErrors { field message }
          }
        }
      `,
      { variables: { id: definition.id, deleteAll: true } },
    );
    const json = await response.json();
    const errors = [
      ...(json.errors || []).map((error) => error.message),
      ...(json.data?.metafieldDefinitionDelete?.userErrors || []).map(
        (error) => error.message,
      ),
    ];
    if (errors.length) throw new Error(errors.join("; "));
  }

  for (const [
    ownerType,
    namespace,
    key,
    name,
    type,
  ] of TRENDS_METAFIELD_DEFINITIONS) {
    if (existing.has(`${ownerType}:${namespace}:${key}`)) continue;
    let response;
    try {
      response = await admin.graphql(
        `#graphql
        mutation CreateTrendsMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id namespace key }
            userErrors { field message }
          }
        }
      `,
        {
          variables: {
            definition: {
              ownerType,
              namespace,
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
      if (
        !requiredKeys.has(
          `${ownerType}:${definition.namespace}:${definition.key}`,
        )
      )
        continue;
      if (definition.pinnedPosition !== null) continue;
      // Pinning only controls visibility in Shopify Admin. It must never stop
      // product creation when a shop/API version refuses this optional step.
      try {
        const response = await admin.graphql(
          `#graphql
          mutation PinTrendsMetafieldDefinition($definitionId: ID!) {
            metafieldDefinitionPin(definitionId: $definitionId) {
              pinnedDefinition { id namespace key pinnedPosition }
              userErrors { field message }
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
  if (preferred) {
    const response = await admin.graphql(
      `#graphql
        query ValidateTrendsInventoryLocation($id: ID!) {
          node(id: $id) { id __typename }
        }
      `,
      { variables: { id: preferred } },
    );
    const json = await response.json();
    if (json.data?.node?.__typename === "Location") return preferred;
  }
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

async function existingShopifyProductId(
  admin,
  productId,
  { product = null, role = null } = {},
) {
  if (!productId) return null;
  const response = await admin.graphql(
    `#graphql
      query ValidateTrendsProduct($id: ID!) {
        product(id: $id) {
          id
          tags
          productType
          variants(first: 250) { nodes { sku } }
        }
      }
    `,
    { variables: { id: productId } },
  );
  const json = await response.json();
  const found = json.data?.product;
  if (!found) return null;
  if (!product || !role) return found.id;
  const expectedSkus = [
    String(product.code),
    ...sellableStockFor(product).map((item) => String(item.stock_code)),
  ].filter(Boolean);
  return productMatchesTrendsIdentity({
    product: found,
    sourceCode: product.code,
    expectedSkus,
    role,
  })
    ? found.id
    : null;
}

export async function auditTrendsShopifyProducts({ admin, rows }) {
  const shopifyProducts = [];
  let after = null;
  do {
    const response = await admin.graphql(
      `#graphql
        query AuditTrendsShopifyProducts($after: String) {
          products(first: 100, after: $after, query: "vendor:TRENDS") {
            nodes {
              id
              title
              status
              tags
              productType
              configuration: metafield(
                namespace: "trends"
                key: "product_configuration"
              ) { value }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { variables: { after } },
    );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    const connection = json.data?.products;
    shopifyProducts.push(...(connection?.nodes || []));
    after = connection?.pageInfo?.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);
  return buildTrendsSyncAudit({ rows, shopifyProducts });
}

async function discoverExistingTrendsProducts(admin, product) {
  const result = { mainProductId: null, masterProductId: null };
  const productTag = String(product.code);
  const legacyProductTag = `TRENDS Product ${product.code}`;
  const handleResponse = await admin.graphql(
    `#graphql
      query ExistingTrendsProductsByHandle(
        $main: ProductIdentifierInput!
        $master: ProductIdentifierInput!
      ) {
        main: productByIdentifier(identifier: $main) {
          id tags productType
        }
        master: productByIdentifier(identifier: $master) {
          id tags productType
        }
      }
    `,
    {
      variables: {
        main: { handle: `trends-${product.code}` },
        master: { handle: `trends-${product.code}-configured-order` },
      },
    },
  );
  const handleJson = await handleResponse.json();
  if (handleJson.errors?.length)
    throw new Error(handleJson.errors.map((error) => error.message).join("; "));
  const handleMain = handleJson.data?.main;
  const handleMaster = handleJson.data?.master;
  if (
    handleMain?.id &&
    !(handleMain.tags || []).includes("TRENDS Master Product")
  )
    result.mainProductId = handleMain.id;
  if (
    handleMaster?.id &&
    ((handleMaster.tags || []).includes("TRENDS Master Product") ||
      handleMaster.productType === "Configured order master")
  )
    result.masterProductId = handleMaster.id;
  const expectedSkus = new Set(
    [
      String(product.code),
      ...sellableStockFor(product).map((item) => String(item.stock_code)),
    ].filter(Boolean),
  );

  for (const sku of result.mainProductId ? [] : expectedSkus) {
    const response = await admin.graphql(
      `#graphql
        query ExistingTrendsProductBySku($query: String!) {
          productVariants(first: 20, query: $query) {
            nodes {
              sku
              product { id tags productType }
            }
          }
        }
      `,
      { variables: { query: `sku:${sku}` } },
    );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    const exact = (json.data?.productVariants?.nodes || []).find((variant) => {
      const tags = variant.product?.tags || [];
      return (
        String(variant.sku) === sku &&
        !tags.includes("TRENDS Master Product") &&
        tags.includes("TRENDS Main Product") &&
        (tags.includes(productTag) || tags.includes(legacyProductTag))
      );
    });
    if (exact?.product?.id) {
      result.mainProductId = exact.product.id;
      break;
    }
  }

  for (const tag of [productTag, legacyProductTag]) {
    const response = await admin.graphql(
      `#graphql
        query ExistingTrendsProductsByTag($query: String!) {
          products(first: 50, query: $query) {
            nodes { id tags productType }
          }
        }
      `,
      { variables: { query: `tag:"${tag}"` } },
    );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    const tagged = (json.data?.products?.nodes || []).filter((item) =>
      (item.tags || []).includes(tag),
    );
    result.mainProductId ||= tagged.find(
      (item) =>
        (item.tags || []).includes("TRENDS Main Product") &&
        !(item.tags || []).includes("TRENDS Master Product"),
    )?.id;
    result.masterProductId ||= tagged.find(
      (item) =>
        (item.tags || []).includes("TRENDS Master Product") ||
        item.productType === "Configured order master",
    )?.id;
    if (result.mainProductId && result.masterProductId) break;
  }
  return result;
}

async function verifyTrendsProductPairOnce({
  admin,
  product,
  mainProductId,
  masterProductId,
}) {
  if (!mainProductId || !masterProductId)
    throw new Error("Main and master Shopify product IDs are required");
  if (mainProductId === masterProductId)
    throw new Error("Main and master Shopify products must be different");
  const response = await admin.graphql(
    `#graphql
      query VerifyTrendsProductPair($mainId: ID!, $masterId: ID!) {
        main: product(id: $mainId) {
          id
          tags
          variants(first: 250) { nodes { sku } }
          configuration: metafield(
            namespace: "trends"
            key: "product_configuration"
          ) { value }
        }
        master: product(id: $masterId) {
          id
          tags
          productType
          variants(first: 20) { nodes { sku } }
        }
      }
    `,
    { variables: { mainId: mainProductId, masterId: masterProductId } },
  );
  const json = await response.json();
  if (json.errors?.length)
    throw new Error(json.errors.map((error) => error.message).join("; "));
  const main = json.data?.main;
  const master = json.data?.master;
  const productTag = String(product.code);
  const sourceSkus = new Set(
    [
      String(product.code),
      ...sellableStockFor(product).map((item) => String(item.stock_code)),
    ].filter(Boolean),
  );
  const errors = [];
  if (!main) errors.push("main product was not found in Shopify");
  if (!master) errors.push("master product was not found in Shopify");
  if (main && !(main.tags || []).includes("TRENDS Main Product"))
    errors.push("main product tag is missing");
  if (main && !(main.tags || []).includes(productTag))
    errors.push("main product source-code tag is missing");
  if (
    main &&
    !(main.variants?.nodes || []).some((variant) =>
      sourceSkus.has(String(variant.sku || "")),
    )
  )
    errors.push("main product source SKU is missing");
  if (!main?.configuration?.value)
    errors.push("main product configuration metafield is missing");
  else {
    try {
      JSON.parse(main.configuration.value);
    } catch {
      errors.push("main product configuration metafield is invalid");
    }
  }
  if (master && !(master.tags || []).includes("TRENDS Master Product"))
    errors.push("master product tag is missing");
  if (master && !(master.tags || []).includes(productTag))
    errors.push("master product source-code tag is missing");
  if (
    master &&
    !(master.variants?.nodes || []).some((variant) =>
      String(variant.sku || "").startsWith(`CFG-CORE-${product.code}-`),
    )
  )
    errors.push("master configured variant is missing");
  if (errors.length)
    throw new Error(`Shopify sync verification failed: ${errors.join("; ")}`);
  return { mainProductId: main.id, masterProductId: master.id };
}

async function verifyTrendsProductPair(args) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await verifyTrendsProductPairOnce(args);
    } catch (error) {
      lastError = error;
      if (
        !/Shopify sync verification failed/i.test(
          error instanceof Error ? error.message : "",
        ) ||
        attempt === 3
      )
        throw error;
      // Product/tag search indexes can briefly lag behind a successful write.
      await waitFor(attempt * 500);
    }
  }
  throw lastError;
}

async function ensureProductTags(admin, productId, tags) {
  const response = await admin.graphql(
    `#graphql
      mutation EnsureTrendsProductTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }
    `,
    { variables: { id: productId, tags } },
  );
  const json = await response.json();
  const errors = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.tagsAdd?.userErrors || []).map((error) => error.message),
  ];
  if (errors.length) throw new Error(errors.join("; "));
}

export async function deleteTrendsShopifyProducts({ admin, items }) {
  const productIds = new Set(
    items
      .flatMap((item) => [
        item.shopifyProductId,
        item.shopifyMasterProductId,
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

async function syncTrendsProductUnlocked({
  admin,
  shop,
  product,
  shopifyProductId = null,
  shopifyMasterProductId = null,
  shopifyAdditionalProductId = null,
  markupPercent,
  fixedShippingAmount = 15,
  locationId,
  extraTags = [],
  templateSuffix = null,
  selectedPublicationIds = null,
  shippingProfileId = null,
  customCorporatePackEnabled = false,
}) {
  shopifyProductId = await existingShopifyProductId(admin, shopifyProductId, {
    product,
    role: "main",
  });
  shopifyMasterProductId = await existingShopifyProductId(
    admin,
    shopifyMasterProductId,
    { product, role: "master" },
  );
  shopifyAdditionalProductId = await existingShopifyProductId(
    admin,
    shopifyAdditionalProductId,
  );
  if (!shopifyProductId || !shopifyMasterProductId) {
    const discovered = await discoverExistingTrendsProducts(admin, product);
    shopifyProductId ||= discovered.mainProductId;
    shopifyMasterProductId ||= discovered.masterProductId;
  }
  const productStatus = shopifyStatusFromTrends(product);
  const indentConfiguration = indentConfigurationFor(product, extraTags);
  const managedExtraTags = [
    ...withoutManagedIndentTags(extraTags),
    ...indentTagsFor(indentConfiguration),
  ];
  const prices = requireTrendsBasePrices(product);
  const sellingPrice = Number(prices[0].price || 0).toFixed(2);
  const sellableStock = sellableStockFor(product);
  const stock = stockWithUniqueOptionLabels(
    sellableStock.length
      ? sellableStock
      : [{ stock_code: product.code, description: "Default", quantity: 0 }],
  );
  const files = (product.images || [])
    .map((image) => {
      const originalSource = shopifyImageUrl(image.link);
      return originalSource
        ? {
            originalSource,
            contentType: "IMAGE",
            alt: `${product.name || product.code} - ${image.caption || image.colour || "product image"}`.slice(
              0,
              512,
            ),
          }
        : null;
    })
    .filter(Boolean);
  const variants = stock.map((item) => {
    const image = imageForStockVariant(product, item);
    return {
      optionValues: [{ optionName: "Colour", name: item.shopifyOptionLabel }],
      sku: String(item.stock_code),
      price: sellingPrice,
      inventoryPolicy: "DENY",
      taxable: true,
      inventoryItem: {
        sku: String(item.stock_code),
        tracked: !indentConfiguration.isIndented,
      },
      ...(!indentConfiguration.isIndented && locationId
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
      ...(shopifyImageUrl(image?.link)
        ? {
            file: {
              originalSource: shopifyImageUrl(image.link),
              contentType: "IMAGE",
            },
          }
        : {}),
    };
  });
  const mainProduct = await runProductSet(
    admin,
    {
      identifier: shopifyProductId ? { id: shopifyProductId } : null,
      input: {
        ...(!shopifyProductId ? { handle: `trends-${product.code}` } : {}),
        title: product.name || `TRENDS ${product.code}`,
        descriptionHtml: descriptionHtml(product),
        vendor: "TRENDS",
        productType: product.categories?.[0]?.name || "Promotional product",
        tags: [
          ...new Set([
            "TRENDS",
            "TRENDS Main Product",
            String(product.code),
            ...(product.categories || []).map((category) => category.name),
            ...managedExtraTags,
          ]),
        ],
        status: productStatus,
        files,
        productOptions: [
          {
            name: "Colour",
            position: 1,
            values: stock.map((item) => ({
              name: item.shopifyOptionLabel,
            })),
          },
        ],
        variants,
      },
    },
    "Main product sync",
  );
  await ensureProductTags(admin, mainProduct.id, [
    "TRENDS",
    "TRENDS Main Product",
    String(product.code),
  ]);
  const brandingEntries = brandingEntriesFor(product);
  if (shopifyAdditionalProductId)
    await deleteLegacyBrandingProduct(admin, shopifyAdditionalProductId);
  await setTrendsProductMetafields({
    admin,
    ownerId: mainProduct.id,
    configuration: configurationFor({
      product,
      markupPercent,
      fixedShippingAmount,
      brandingEntries,
      customCorporatePackEnabled,
    }),
  });
  let publicationWarning = null;
  try {
    await applyProductTemplateAndSalesChannels({
      admin,
      productId: mainProduct.id,
      templateSuffix,
      selectedPublicationIds,
    });
  } catch (error) {
    publicationWarning = `Product synced, but template/sales-channel assignment is pending: ${
      error instanceof Error ? error.message : "Assignment failed"
    }`;
  }
  const masterProductId = await syncConfiguredMasterProduct({
    admin,
    product,
    shopifyMasterProductId,
    markupPercent,
    fixedShippingAmount,
    customCorporatePackEnabled,
    indentConfiguration,
  });
  await syncConfiguredMasterVariantPrices({
    admin,
    shop,
    masterProductId,
    product,
    markupPercent,
    fixedShippingAmount,
    customCorporatePackEnabled,
  });
  await assignProductsToShippingProfile({
    admin,
    profileId: shippingProfileId,
    productIds: [mainProduct.id, masterProductId],
  });
  await verifyTrendsProductPair({
    admin,
    product,
    mainProductId: mainProduct.id,
    masterProductId,
  });
  return {
    ...mainProduct,
    masterProductId,
    publicationWarning,
    additionalProducts: [],
  };
}

const trendsProductSyncLocks = new Map();

export async function syncTrendsProduct(args) {
  const lockKey = `${args.shop || "shop"}:${args.product?.code || "product"}`;
  const previous = trendsProductSyncLocks.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  trendsProductSyncLocks.set(lockKey, current);
  await previous;
  try {
    return await withShopifyThrottleRetry(() =>
      syncTrendsProductUnlocked(args),
    );
  } finally {
    release();
    if (trendsProductSyncLocks.get(lockKey) === current)
      trendsProductSyncLocks.delete(lockKey);
  }
}

async function syncTrendsPriceAndInventoryOnce({
  admin,
  shop,
  product,
  shopifyProductId,
  shopifyMasterProductId,
  shopifyAdditionalProductId,
  markupPercent,
  fixedShippingAmount = 15,
  locationId,
  extraTags = [],
  customCorporatePackEnabled = false,
  refreshConfiguration = true,
  refreshConfiguredPrices = true,
}) {
  const prices = requireTrendsBasePrices(product);

  const mainPrice = Number(prices[0].price || 0).toFixed(2);
  const indentConfiguration = indentConfigurationFor(product, extraTags);
  const mainStock = new Map(
    sellableStockFor(product).map((item) => [
      String(item.stock_code),
      Math.max(0, Math.trunc(Number(item.quantity) || 0)),
    ]),
  );

  const getProductState = async (productId) => {
    if (!productId) return { tags: [], variants: [] };
    const response = await admin.graphql(
      `#graphql
        query TrendsCronVariants($id: ID!) {
          product(id: $id) {
            tags
            variants(first: 250) {
              nodes { id sku price inventoryQuantity inventoryItem { id tracked } }
            }
          }
        }
      `,
      { variables: { id: productId } },
    );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    return {
      tags: json.data?.product?.tags || [],
      variants: json.data?.product?.variants?.nodes || [],
    };
  };

  const updatePrices = async (productId, variants) => {
    if (!productId || !variants.length) return;
    const response = await admin.graphql(
      `#graphql
        mutation TrendsCronPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price }
            userErrors { field message }
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

  const mainState = await getProductState(shopifyProductId);
  const mainVariants = mainState.variants;
  if (indentConfiguration.isIndented) {
    const desiredIndentTags = indentTagsFor(indentConfiguration);
    const tags = [
      ...withoutManagedIndentTags(mainState.tags),
      ...desiredIndentTags,
    ];
    if (desiredIndentTags.some((tag) => !mainState.tags.includes(tag))) {
      await runProductSet(
        admin,
        { identifier: { id: shopifyProductId }, input: { tags } },
        "Indent tag sync",
      );
    }
  }
  const priceChanges = mainVariants
    .filter(
      (variant) =>
        Number(Number(variant.price || 0).toFixed(2)) !== Number(mainPrice),
    )
    .map((variant) => ({
      variantId: variant.id,
      sku: variant.sku || "No SKU",
      from: Number(variant.price || 0).toFixed(2),
      to: mainPrice,
    }));
  const priceUpdates = priceChanges.map((change) => ({
    id: change.variantId,
    price: change.to,
  }));
  if (indentConfiguration.isIndented) {
    const updatesById = new Map(
      priceUpdates.map((update) => [update.id, update]),
    );
    for (const variant of mainVariants) {
      if (variant.inventoryItem?.tracked === false) continue;
      updatesById.set(variant.id, {
        ...(updatesById.get(variant.id) || { id: variant.id }),
        inventoryItem: { tracked: false },
      });
    }
    priceUpdates.splice(0, priceUpdates.length, ...updatesById.values());
  }
  await updatePrices(shopifyProductId, priceUpdates);

  let inventoryChecked = 0;
  let inventoryChanged = 0;
  let inventoryChanges = [];
  if (!indentConfiguration.isIndented && locationId) {
    const comparableInventory = mainVariants.filter(
      (variant) => variant.inventoryItem?.id && mainStock.has(variant.sku),
    );
    inventoryChecked = comparableInventory.length;
    inventoryChanges = comparableInventory
      .filter(
        (variant) =>
          Number(variant.inventoryQuantity || 0) !== mainStock.get(variant.sku),
      )
      .map((variant) => ({
        inventoryItemId: variant.inventoryItem.id,
        sku: variant.sku || "No SKU",
        from: Number(variant.inventoryQuantity || 0),
        to: mainStock.get(variant.sku),
      }));
    const quantities = inventoryChanges.map((change) => ({
      inventoryItemId: change.inventoryItemId,
      locationId,
      quantity: change.to,
      changeFromQuantity: null,
    }));
    inventoryChanged = quantities.length;
    if (quantities.length) {
      const response = await admin.graphql(
        `#graphql
          mutation TrendsCronInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
            inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
              inventoryAdjustmentGroup { createdAt }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            idempotencyKey: randomUUID(),
            input: {
              name: "available",
              reason: "correction",
              referenceDocumentUri: `trends://products/${product.code}`,
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

  if (shopifyAdditionalProductId)
    await deleteLegacyBrandingProduct(admin, shopifyAdditionalProductId);
  if (refreshConfiguration) {
    await setTrendsProductMetafields({
      admin,
      ownerId: shopifyProductId,
      configuration: configurationFor({
        product,
        markupPercent,
        fixedShippingAmount,
        brandingEntries: brandingEntriesFor(product),
        customCorporatePackEnabled,
      }),
    });
  }

  let masterProductId = shopifyMasterProductId;
  let configuredVariants = 0;
  if (refreshConfiguredPrices) {
    if (!masterProductId) {
      masterProductId = await syncConfiguredMasterProduct({
        admin,
        product,
        shopifyMasterProductId,
        markupPercent,
        fixedShippingAmount,
        indentConfiguration,
      });
    }
    configuredVariants = await syncConfiguredMasterVariantPrices({
      admin,
      shop,
      masterProductId,
      product,
      markupPercent,
      fixedShippingAmount,
      customCorporatePackEnabled,
    });
  }
  return {
    masterProductId,
    configuredVariants,
    variants: mainVariants.length,
    inventory: mainVariants.filter((variant) => mainStock.has(variant.sku))
      .length,
    priceChecked: mainVariants.length,
    priceChanged: priceChanges.length,
    priceUnchanged: mainVariants.length - priceChanges.length,
    priceChanges,
    inventoryChecked,
    inventoryChanged,
    inventoryUnchanged: inventoryChecked - inventoryChanged,
    inventoryChanges,
  };
}

export async function syncTrendsPriceAndInventory(args) {
  return withShopifyThrottleRetry(() => syncTrendsPriceAndInventoryOnce(args));
}

async function getTrendsProductConfiguration(admin, ownerId) {
  const response = await admin.graphql(
    `#graphql
      query ExistingTrendsProductConfiguration($id: ID!) {
        node(id: $id) {
          ... on Product {
            metafield(namespace: "trends", key: "product_configuration") {
              value
            }
          }
        }
      }
    `,
    { variables: { id: ownerId } },
  );
  const json = await response.json();
  if (json.errors?.length)
    throw new Error(json.errors.map((error) => error.message).join("; "));
  try {
    return JSON.parse(json.data?.node?.metafield?.value || "{}");
  } catch {
    return {};
  }
}

async function setTrendsProductMetafields({ admin, ownerId, configuration }) {
  const existingConfiguration = await getTrendsProductConfiguration(
    admin,
    ownerId,
  );
  const mergedConfiguration = {
    ...existingConfiguration,
    ...configuration,
  };
  const response = await admin.graphql(
    `#graphql
      mutation LinkTrendsProduct($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value }
          userErrors { field message }
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
            value: JSON.stringify(mergedConfiguration),
          },
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
  await deleteLegacyAdditionalProductMetafield(admin, ownerId);
}

export async function setConfiguredVariantMetafield({
  admin,
  ownerId,
  configuration,
}) {
  await setTrendsProductMetafields({
    admin,
    ownerId,
    configuration: { custom_variant_configuration: configuration },
  });
  // Remove superseded custom-namespace values. The configuration now lives
  // only inside trends.product_configuration.
  try {
    await admin.graphql(
      `#graphql
        mutation DeleteLegacyConfiguredVariant($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields { ownerId namespace key }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          metafields: [
            {
              ownerId,
              namespace: "custom",
              key: "custom_configured_variant",
            },
            {
              ownerId,
              namespace: "custom",
              key: "custom_variants_configuration",
            },
          ],
        },
      },
    );
  } catch {
    // The nested canonical configuration is already saved; cleanup is optional.
  }
}

async function deleteLegacyBrandingProduct(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      mutation DeleteLegacyTrendsBrandingProduct($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors { field message }
        }
      }
    `,
    { variables: { input: { id: productId } } },
  );
  const json = await response.json();
  const errors = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.productDelete?.userErrors || []).map(
      (error) => error.message,
    ),
  ];
  const missingOnly =
    errors.length &&
    errors.every((message) => /does not exist|not found/i.test(message));
  if (errors.length && !missingOnly) throw new Error(errors.join("; "));
}

async function deleteLegacyAdditionalProductMetafield(admin, ownerId) {
  const response = await admin.graphql(
    `#graphql
      mutation DeleteLegacyTrendsAdditionalProductMetafield($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { ownerId namespace key }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [
          { ownerId, namespace: "trends", key: "additional_product" },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = [
    ...(json.errors || []).map((error) => error.message),
    ...(json.data?.metafieldsDelete?.userErrors || []).map(
      (error) => error.message,
    ),
  ];
  if (errors.length) throw new Error(errors.join("; "));
}

const masterTagsFor = (
  product,
  indentConfiguration = indentConfigurationFor(product),
) => [
  "TRENDS",
  "TRENDS Master Product",
  "TRENDS Hidden Product",
  String(product.code),
  ...indentTagsFor(indentConfiguration),
];

const masterSkuPart = (value) =>
  String(value || "NA")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

const masterVariantKey = (options) =>
  ["Type", "Colour", "Configuration"]
    .map(
      (name) =>
        options.find(
          (option) => option.name.toLowerCase() === name.toLowerCase(),
        )?.value || "",
    )
    .join("\u0001");

async function syncConfiguredMasterProduct({
  admin,
  product,
  shopifyMasterProductId,
  markupPercent,
  fixedShippingAmount = 15,
  indentConfiguration = indentConfigurationFor(product),
}) {
  const prices = requireTrendsBasePrices(product);
  const baseQuantity = Math.max(1, Math.trunc(Number(prices[0].quantity) || 1));
  const stock = sellableStockFor(product);
  const coreStock = stockWithUniqueOptionLabels(
    stock.length
      ? stock
      : [{ stock_code: product.code, description: "Default" }],
  );
  const entries = brandingEntriesFor(product);
  const brandingEntries = entries.filter((entry) => entry.mode === "branding");
  const giftEntries = entries.filter((entry) => entry.mode === "gift_ready");
  const files = (product.images || [])
    .map((image) => {
      const originalSource = shopifyImageUrl(image.link);
      return originalSource
        ? {
            originalSource,
            contentType: "IMAGE",
            alt: `${product.name || product.code} - ${image.caption || image.colour || "product image"}`.slice(
              0,
              512,
            ),
          }
        : null;
    })
    .filter(Boolean);
  const definitionFor = (item, brandingEntry = null, giftEntry = null) => {
    const image = imageForStockVariant(product, item);
    const selections = [brandingEntry, giftEntry]
      .filter(Boolean)
      .map((entry) => ({ sku: entry.unitSku, quantity: baseQuantity }));
    const calculated = calculateTrendsTierPrice({
      product,
      quantity: baseQuantity,
      markupPercent,
      fixedShippingAmount,
      additionalSelections: selections,
    });
    const price = Number((calculated.subtotal / baseQuantity).toFixed(2));
    const type = giftEntry
      ? "Branded + Packaging"
      : brandingEntry
        ? "Branded"
        : "Unbranded";
    const configuration =
      [
        brandingEntry ? `Branding: ${brandingEntry.optionName}` : null,
        giftEntry ? `Packaging: ${giftEntry.optionName}` : null,
      ]
        .filter(Boolean)
        .join(" | ") || "None";
    const optionValues = [
      { optionName: "Type", name: type },
      {
        optionName: "Colour",
        name: item.shopifyOptionLabel,
      },
      { optionName: "Configuration", name: configuration },
    ];
    return {
      optionValues,
      key: masterVariantKey(
        optionValues.map((option) => ({
          name: option.optionName,
          value: option.name,
        })),
      ),
      sku: [
        "CFG-CORE",
        masterSkuPart(product.code),
        masterSkuPart(item.stock_code),
        masterSkuPart(brandingEntry?.costKey || "U"),
        masterSkuPart(giftEntry?.costKey || "N"),
      ].join("-"),
      price: price.toFixed(2),
      inventoryPolicy: "CONTINUE",
      inventoryItem: { tracked: !indentConfiguration.isIndented },
      taxable: true,
      published: true,
      imageUrl: shopifyImageUrl(image?.link),
      ...(shopifyImageUrl(image?.link)
        ? {
            file: {
              originalSource: shopifyImageUrl(image.link),
              contentType: "IMAGE",
            },
          }
        : {}),
    };
  };
  const desiredVariants = [];
  for (const item of coreStock) {
    desiredVariants.push(definitionFor(item));
    for (const giftEntry of giftEntries)
      desiredVariants.push(definitionFor(item, null, giftEntry));
    for (const brandingEntry of brandingEntries) {
      desiredVariants.push(definitionFor(item, brandingEntry));
      for (const giftEntry of giftEntries)
        desiredVariants.push(definitionFor(item, brandingEntry, giftEntry));
    }
  }
  // TRENDS can repeat the same additional-cost method under different charge
  // records. Shopify identifies a variant by its option combination, not SKU,
  // so only one definition may be sent for each Type/Colour/Configuration key.
  const uniqueDesiredVariants = [
    ...new Map(
      desiredVariants.map((definition) => [definition.key, definition]),
    ).values(),
  ];
  // Shopify currently supports up to 2,048 variants per product. Keep room for
  // merchant-created configurations; non-prebuilt combinations remain on-demand.
  let prebuiltVariants = uniqueDesiredVariants.slice(
    0,
    MANAGED_CORE_VARIANT_TARGET,
  );

  if (!shopifyMasterProductId) {
    const initialVariants = prebuiltVariants.filter(
      (variant) => variant.optionValues[0].name === "Unbranded",
    );
    const created = await runProductSet(
      admin,
      {
        identifier: null,
        input: {
          handle: `trends-${product.code}-configured-order`,
          title: product.name || `TRENDS ${product.code}`,
          descriptionHtml:
            "<p>Hidden master product used for configured TRENDS cart items.</p>",
          vendor: "TRENDS",
          productType: "Configured order master",
          tags: masterTagsFor(product, indentConfiguration),
          status: "UNLISTED",
          files,
          productOptions: [
            {
              name: "Type",
              position: 1,
              values: [
                ...new Set(
                  initialVariants.map(
                    (variant) => variant.optionValues[0].name,
                  ),
                ),
              ].map((name) => ({ name })),
            },
            {
              name: "Colour",
              position: 2,
              values: [
                ...new Set(
                  initialVariants.map(
                    (variant) => variant.optionValues[1].name,
                  ),
                ),
              ].map((name) => ({ name })),
            },
            {
              name: "Configuration",
              position: 3,
              values: [
                ...new Set(
                  initialVariants.map(
                    (variant) => variant.optionValues[2].name,
                  ),
                ),
              ].map((name) => ({ name })),
            },
          ],
          variants: initialVariants.map((variant) => ({
            optionValues: variant.optionValues,
            sku: variant.sku,
            price: variant.price,
            inventoryPolicy: variant.inventoryPolicy,
            inventoryItem: variant.inventoryItem,
            taxable: variant.taxable,
            published: variant.published,
            ...(variant.file ? { file: variant.file } : {}),
          })),
        },
      },
      "Master product creation",
    );
    await publishProductToOnlineStore(admin, created.id);
    shopifyMasterProductId = created.id;
  }

  await runProductSet(
    admin,
    {
      identifier: { id: shopifyMasterProductId },
      input: {
        title: product.name || `TRENDS ${product.code}`,
        vendor: "TRENDS",
        productType: "Configured order master",
        tags: masterTagsFor(product, indentConfiguration),
        status: "UNLISTED",
      },
    },
    "Master product update",
  );
  await ensureProductTags(
    admin,
    shopifyMasterProductId,
    masterTagsFor(product, indentConfiguration),
  );
  const existingVariants = [];
  let after = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query ConfiguredMasterCoreVariants($id: ID!, $after: String) {
          product(id: $id) {
            variants(first: 250, after: $after) {
              nodes {
                id sku
                selectedOptions { name value }
                media(first: 1) { nodes { id } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      { variables: { id: shopifyMasterProductId, after } },
    );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(json.errors.map((error) => error.message).join("; "));
    const connection = json.data?.product?.variants;
    existingVariants.push(...(connection?.nodes || []));
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    after = connection?.pageInfo?.endCursor || null;
    if (hasNextPage && !after)
      throw new Error("Shopify did not return the next variant page cursor");
  }
  const capacityPlan = planManagedCoreVariants({
    desiredVariants: uniqueDesiredVariants,
    existingVariants: existingVariants.map((variant) => ({
      ...variant,
      key: masterVariantKey(variant.selectedOptions || []),
    })),
  });
  prebuiltVariants = capacityPlan.targetVariants;
  const deletionPhases = planSafeVariantDeletionPhases({
    existingVariants,
    staleVariantIds: capacityPlan.staleManagedVariantIds,
  });
  const deleteVariants = async (variantIds) => {
    for (let index = 0; index < variantIds.length; index += 250) {
      const deleteResponse = await admin.graphql(
        `#graphql
          mutation DeleteObsoleteConfiguredMasterCoreVariants($productId: ID!, $variantIds: [ID!]!) {
            productVariantsBulkDelete(productId: $productId, variantsIds: $variantIds) {
              product { id }
              userErrors { field message }
            }
          }
        `,
        {
          variables: {
            productId: shopifyMasterProductId,
            variantIds: variantIds.slice(index, index + 250),
          },
        },
      );
      const deleteJson = await deleteResponse.json();
      const errors = [
        ...(deleteJson.errors || []).map((error) => error.message),
        ...(deleteJson.data?.productVariantsBulkDelete?.userErrors || []).map(
          (error) => error.message,
        ),
      ];
      if (errors.length) throw new Error(errors.join("; "));
    }
  };
  await deleteVariants(deletionPhases.beforeCreate);
  const existing = new Map(
    capacityPlan.retainedExistingVariants.map((variant) => [
      variant.key,
      variant,
    ]),
  );
  const updates = prebuiltVariants
    .map((definition) => ({
      definition,
      variant: existing.get(definition.key),
    }))
    .filter((item) => item.variant)
    .map(({ definition, variant }) => ({
      id: variant.id,
      price: definition.price,
      ...(indentConfiguration.isIndented
        ? { inventoryItem: { tracked: false } }
        : {}),
    }));
  for (let index = 0; index < updates.length; index += 250) {
    const updateResponse = await admin.graphql(
      `#graphql
        mutation UpdateConfiguredMasterCorePrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          productId: shopifyMasterProductId,
          variants: updates.slice(index, index + 250),
        },
      },
    );
    const updateJson = await updateResponse.json();
    const errors = [
      ...(updateJson.errors || []).map((error) => error.message),
      ...(updateJson.data?.productVariantsBulkUpdate?.userErrors || []).map(
        (error) => error.message,
      ),
    ];
    if (errors.length) throw new Error(errors.join("; "));
  }
  const missing = prebuiltVariants.filter(
    (definition) => !existing.has(definition.key),
  );
  for (let index = 0; index < missing.length; index += 250) {
    const batch = missing.slice(index, index + 250);
    const createResponse = await admin.graphql(
      `#graphql
        mutation CreateConfiguredMasterCoreVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          productId: shopifyMasterProductId,
          variants: batch.map((definition) => ({
            optionValues: definition.optionValues,
            inventoryItem: {
              sku: definition.sku,
              tracked: !indentConfiguration.isIndented,
            },
            price: definition.price,
            inventoryPolicy: "CONTINUE",
            taxable: true,
            published: true,
            ...(definition.imageUrl ? { mediaSrc: [definition.imageUrl] } : {}),
          })),
        },
      },
    );
    const createJson = await createResponse.json();
    const errors = [
      ...(createJson.errors || []).map((error) => error.message),
      ...(createJson.data?.productVariantsBulkCreate?.userErrors || []).map(
        (error) => error.message,
      ),
    ];
    if (errors.length) throw new Error(errors.join("; "));
  }
  if (missing.length) await deleteVariants(deletionPhases.afterCreate);
  await publishProductToOnlineStore(admin, shopifyMasterProductId);
  return shopifyMasterProductId;
}

async function syncConfiguredMasterVariantPrices({
  admin,
  shop,
  masterProductId,
  product,
  markupPercent,
  fixedShippingAmount = 15,
  customCorporatePackEnabled = false,
}) {
  if (!shop || !masterProductId) return 0;
  const rows = await prisma.temporaryConfiguredVariant.findMany({
    where: { shop, targetProductId: masterProductId },
  });
  if (!rows.length) return 0;
  const entries = brandingEntriesFor(product);
  const updates = [];
  const databaseUpdates = [];
  for (const row of rows) {
    let saved;
    try {
      saved = JSON.parse(row.configurationJson);
    } catch {
      continue;
    }
    const selections = [
      saved.brandingId
        ? {
            entry: entries.find(
              (candidate) =>
                String(candidate.costKey) === String(saved.brandingId),
            ),
            quantity: saved.brandingQuantity || saved.requestedQuantity,
          }
        : null,
      saved.giftBoxId || saved.packagingId
        ? {
            entry:
              String(saved.packagingId || saved.giftBoxId) ===
                "custom-corporate-pack" && customCorporatePackEnabled
                ? {
                    costKey: "custom-corporate-pack",
                    optionName: "Custom Corporate Pack",
                    mode: "gift_ready",
                    unitSku: "CUSTOM-CORPORATE-PACK",
                    directUnitPrice: 0,
                  }
                : entries.find(
                    (candidate) =>
                      String(candidate.costKey) ===
                      String(saved.giftBoxId || saved.packagingId),
                  ),
            quantity: saved.packagingQuantity || saved.requestedQuantity,
          }
        : null,
    ].filter(Boolean);
    if (selections.some((selection) => !selection.entry)) continue;
    const calculated = calculateTrendsTierPrice({
      product,
      quantity: saved.requestedQuantity,
      markupPercent,
      fixedShippingAmount,
      additionalSelections: selections.map((selection) => ({
        sku: selection.entry.unitSku,
        quantity: selection.quantity,
        id: selection.entry.costKey,
        name: selection.entry.optionName,
        mode: selection.entry.mode,
        unitPrice: Number.isFinite(selection.entry.directUnitPrice)
          ? selection.entry.directUnitPrice
          : undefined,
        setupPrice: Number.isFinite(selection.entry.directUnitPrice)
          ? 0
          : undefined,
      })),
      shippingService: saved.shippingService || saved.shipping?.service,
    });
    const price = Number(
      (calculated.subtotal / Math.max(1, saved.requestedQuantity)).toFixed(2),
    );
    updates.push({ id: row.shopifyVariantId, price: price.toFixed(2) });
    databaseUpdates.push({
      id: row.id,
      price,
      configurationJson: JSON.stringify({
        ...saved,
        calculated,
        subtotal: calculated.subtotal,
      }),
    });
  }
  for (let index = 0; index < updates.length; index += 250) {
    const response = await admin.graphql(
      `#graphql
        mutation RefreshConfiguredMasterVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          productId: masterProductId,
          variants: updates.slice(index, index + 250),
        },
      },
    );
    const json = await response.json();
    const errors = [
      ...(json.errors || []).map((error) => error.message),
      ...(json.data?.productVariantsBulkUpdate?.userErrors || []).map(
        (error) => error.message,
      ),
    ];
    if (errors.length) throw new Error(errors.join("; "));
  }
  await Promise.all(
    databaseUpdates.map((update) =>
      prisma.temporaryConfiguredVariant.update({
        where: { id: update.id },
        data: {
          price: update.price,
          configurationJson: update.configurationJson,
        },
      }),
    ),
  );
  return updates.length;
}

async function runProductSet(admin, variables, operation = "Product sync") {
  const response = await admin.graphql(
    `#graphql
    mutation SyncTrendsProduct($identifier: ProductSetIdentifiers, $input: ProductSetInput!, $synchronous: Boolean!) {
      productSet(identifier: $identifier, input: $input, synchronous: $synchronous) {
        product {
          id title handle status
          variants(first: 250) { nodes { id sku title } }
        }
        userErrors { field message }
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
  if (message) throw new Error(`${operation}: ${message}`);
  if (!json.data?.productSet?.product)
    throw new Error("Shopify did not return the synced product");
  const product = json.data.productSet.product;
  return { ...product, variants: product.variants?.nodes || [] };
}
