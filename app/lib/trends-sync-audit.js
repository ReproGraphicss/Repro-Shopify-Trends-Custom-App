const numericSourceTag = (tags = []) =>
  tags.find((tag) => /^\d{6}$/.test(String(tag).trim())) || null;

export const classifyTrendsShopifyProduct = (product) => {
  const tags = Array.isArray(product?.tags) ? product.tags : [];
  const isMaster =
    tags.includes("TRENDS Master Product") ||
    product?.productType === "Configured order master";
  const isMain = tags.includes("TRENDS Main Product") && !isMaster;
  return {
    ...product,
    code: numericSourceTag(tags),
    role: isMaster ? "master" : isMain ? "main" : "unknown",
  };
};

export const productMatchesTrendsIdentity = ({
  product,
  sourceCode,
  expectedSkus = [],
  role,
}) => {
  if (!product?.id) return false;
  const classified = classifyTrendsShopifyProduct(product);
  if (classified.role !== role) return false;
  if (classified.code === String(sourceCode)) return true;
  if (classified.code && classified.code !== String(sourceCode)) return false;
  const skus = new Set(
    (product.variants?.nodes || []).map((variant) => String(variant.sku || "")),
  );
  if (role === "master") {
    return [...skus].some((sku) =>
      sku.startsWith(`CFG-CORE-${sourceCode}-`),
    );
  }
  return expectedSkus.some((sku) => skus.has(String(sku)));
};

export const buildTrendsSyncAudit = ({ rows, shopifyProducts }) => {
  const byCode = new Map();
  for (const rawProduct of shopifyProducts) {
    const product = classifyTrendsShopifyProduct(rawProduct);
    if (!product.code || product.role === "unknown") continue;
    const entry = byCode.get(product.code) || { main: [], master: [] };
    entry[product.role].push(product);
    byCode.set(product.code, entry);
  }

  const groupedRows = new Map();
  for (const row of rows) {
    let source = null;
    try {
      source = row.trendsDataJson ? JSON.parse(row.trendsDataJson) : null;
    } catch {
      source = null;
    }
    const code = String(
      source?.code || row.resolvedProductCode || row.productCode,
    );
    const group = groupedRows.get(code) || { code, rows: [], source: null };
    group.rows.push(row);
    if (!group.source && source) group.source = source;
    groupedRows.set(code, group);
  }

  const issues = [];
  let healthy = 0;
  const expectedCodes = new Set(groupedRows.keys());
  const expectedMainProducts = shopifyProducts
    .map(classifyTrendsShopifyProduct)
    .filter(
      (product) =>
        product.role === "main" && expectedCodes.has(String(product.code)),
    );
  const mainProductsByCode = new Map();
  for (const product of expectedMainProducts) {
    const products = mainProductsByCode.get(product.code) || [];
    products.push(product);
    mainProductsByCode.set(product.code, products);
  }
  for (const group of groupedRows.values()) {
    const { code, source } = group;
    const row =
      group.rows.find(
        (item) => item.shopifyProductId && item.shopifyMasterProductId,
      ) || group.rows[0];
    const rowIds = group.rows.map((item) => item.id);
    if (!source) {
      issues.push({
        id: row.id,
        rowIds,
        productCode: code,
        title: row.title || `TRENDS ${code}`,
        reason: "Supplier details have not been fetched",
        issueType: "FETCH_REQUIRED",
        canSync: false,
      });
      continue;
    }

    const matches = byCode.get(code) || { main: [], master: [] };
    const reasons = [];
    const hasDuplicates = matches.main.length > 1 || matches.master.length > 1;
    if (!matches.main.length) reasons.push("Main storefront product is missing");
    if (!matches.master.length) reasons.push("Configured master product is missing");
    if (matches.main.length > 1) reasons.push("Multiple main products were found");
    if (matches.master.length > 1)
      reasons.push("Multiple configured master products were found");

    const main = matches.main[0] || null;
    const master = matches.master[0] || null;
    if (main && group.rows.some((item) => item.shopifyProductId !== main.id))
      reasons.push("Saved main product link is incorrect");
    if (
      master &&
      group.rows.some((item) => item.shopifyMasterProductId !== master.id)
    )
      reasons.push("Saved master product link is incorrect");
    if (main) {
      const configuration = main.configuration?.value;
      if (!configuration) reasons.push("Product configuration is missing");
      else {
        try {
          JSON.parse(configuration);
        } catch {
          reasons.push("Product configuration is invalid");
        }
      }
    }
    const failedRow = group.rows.find(
      (item) => item.status === "FAILED" && item.lastError,
    );
    if (failedRow) reasons.push(`Last sync failed: ${failedRow.lastError}`);

    if (!reasons.length) {
      healthy++;
      continue;
    }
    issues.push({
      id: row.id,
      rowIds,
      productCode: code,
      title: row.title || source.name || `TRENDS ${code}`,
      reason: reasons.join(" · "),
      issueType: "SHOPIFY_SYNC",
      canSync: !hasDuplicates,
      actionLabel: hasDuplicates ? "Manual review" : "Repair available",
      shopifyProductId: main?.id || null,
      shopifyMasterProductId: master?.id || null,
    });
  }

  return {
    checked: groupedRows.size,
    healthy,
    mainProducts: mainProductsByCode.size,
    activeMainProducts: [...mainProductsByCode.values()].filter((products) =>
      products.some((product) => product.status === "ACTIVE"),
    ).length,
    draftMainProducts: [...mainProductsByCode.values()].filter(
      (products) =>
        !products.some((product) => product.status === "ACTIVE") &&
        products.some((product) => product.status === "DRAFT"),
    ).length,
    duplicateMainProducts: [...mainProductsByCode.values()].reduce(
      (total, products) => total + Math.max(0, products.length - 1),
      0,
    ),
    issues,
    repairable: issues.filter((item) => item.canSync).length,
  };
};
