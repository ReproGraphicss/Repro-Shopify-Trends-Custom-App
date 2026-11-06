const validBasePriceTiers = (pricing) =>
  (Array.isArray(pricing?.prices) ? pricing.prices : [])
    .map((tier) => ({ ...tier, price: Number(tier?.price) }))
    .filter((tier) => Number.isFinite(tier.price) && tier.price > 0);

// Most TRENDS products put unbranded pricing in the first pricing block, but
// custom products can return an empty descriptor before a later priced block.
export const trendsBasePricingFor = (product) =>
  (Array.isArray(product?.pricing) ? product.pricing : []).find(
    (pricing) => validBasePriceTiers(pricing).length,
  ) || null;

export const trendsBasePricesFor = (product) =>
  validBasePriceTiers(trendsBasePricingFor(product));

export const isTrendsQuoteOnlyProduct = (product) =>
  !trendsBasePricingFor(product);

export const requireTrendsBasePrices = (product) => {
  const prices = trendsBasePricesFor(product);
  if (!prices.length) {
    const error = new Error(
      "Quote-only product: TRENDS does not provide a base price for this custom item",
    );
    error.code = "TRENDS_QUOTE_ONLY";
    throw error;
  }
  return prices;
};

export const isTrendsQuoteOnlyError = (error) =>
  error?.code === "TRENDS_QUOTE_ONLY" ||
  /^Quote-only product:/i.test(String(error?.message || error || ""));
