import assert from "node:assert/strict";

import {
  isTrendsQuoteOnlyError,
  isTrendsQuoteOnlyProduct,
  requireTrendsBasePrices,
  trendsBasePricingFor,
} from "../app/lib/trends-base-pricing.js";

const productWithDelayedPricing = {
  pricing: [
    { primary_price_description: "Custom", prices: [] },
    {
      primary_price_description: "Unbranded",
      prices: [
        { quantity: 25, price: "4.20" },
        { quantity: 50, price: "3.90" },
      ],
    },
  ],
};

assert.equal(
  trendsBasePricingFor(productWithDelayedPricing).primary_price_description,
  "Unbranded",
);
assert.deepEqual(
  requireTrendsBasePrices(productWithDelayedPricing).map((tier) => tier.price),
  [4.2, 3.9],
);
assert.equal(isTrendsQuoteOnlyProduct(productWithDelayedPricing), false);

const quoteOnlyProduct = {
  code: 104077,
  name: "Special Design AD Labels",
  pricing: [{ primary_price_description: "Price on application", prices: [] }],
};
assert.equal(isTrendsQuoteOnlyProduct(quoteOnlyProduct), true);
assert.throws(
  () => requireTrendsBasePrices(quoteOnlyProduct),
  (error) => isTrendsQuoteOnlyError(error),
);

console.log("TRENDS base-pricing checks passed.");
