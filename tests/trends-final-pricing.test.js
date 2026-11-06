import assert from "node:assert/strict";

import { calculateFinalPricing } from "../app/lib/trends-final-pricing.js";
import {
  configuredSelectionLabel,
  standardPackagingSelection,
} from "../app/lib/trends-configured-identity.js";

const branded = calculateFinalPricing({
  baseUnitPrice: 13.21,
  quantity: 25,
  markupPercent: 40,
  fixedShippingAmount: 15,
  additionalCosts: [
    { mode: "branding", unitPrice: 3, setupPrice: 40, quantity: 25 },
  ],
});

assert.equal(branded.rawSubtotal, 460.25);
assert.equal(branded.markupAmount, 184.1);
assert.equal(branded.subtotal, 644.35);
assert.equal(branded.unitPrice, 25.77);
assert.equal(branded.shippingCharge, 15);

const unbranded = calculateFinalPricing({
  baseUnitPrice: 13.21,
  quantity: 25,
  markupPercent: 40,
  fixedShippingAmount: 15,
});
assert.equal(unbranded.rawSubtotal, 345.25);
assert.equal(unbranded.subtotal, 483.35);

const giftReady = calculateFinalPricing({
  baseUnitPrice: 13.21,
  quantity: 25,
  markupPercent: 40,
  fixedShippingAmount: 15,
  additionalCosts: [
    { mode: "branding", unitPrice: 3, setupPrice: 40, quantity: 25 },
    { mode: "gift_ready", unitPrice: 2, setupPrice: 10, quantity: 25 },
  ],
});
assert.equal(giftReady.rawSubtotal, 520.25);
assert.equal(giftReady.subtotal, 728.35);
assert.equal(giftReady.packagingUnitPrice, 2);

const customCorporatePack = calculateFinalPricing({
  baseUnitPrice: 13.21,
  quantity: 25,
  markupPercent: 40,
  fixedShippingAmount: 15,
  additionalCosts: [
    { mode: "gift_ready", unitPrice: 0, setupPrice: 0, quantity: 25 },
  ],
});
assert.equal(customCorporatePack.setupPrice, 0);
assert.equal(customCorporatePack.packagingUnitPrice, 0);
assert.equal(customCorporatePack.rawSubtotal, 345.25);
assert.equal(customCorporatePack.subtotal, 483.35);

// A second product with different supplier inputs proves that the calculation
// is data-driven; the Compadre figures above are only a regression fixture.
const anotherProduct = calculateFinalPricing({
  baseUnitPrice: 7.5,
  quantity: 40,
  markupPercent: 25,
  fixedShippingAmount: 22,
  additionalCosts: [
    { mode: "branding", unitPrice: 1.25, setupPrice: 30, quantity: 40 },
    { mode: "gift_ready", unitPrice: 0.75, setupPrice: 5, quantity: 40 },
  ],
});
assert.equal(anotherProduct.rawSubtotal, 437);
assert.equal(anotherProduct.markupAmount, 109.25);
assert.equal(anotherProduct.subtotal, 546.25);
assert.equal(anotherProduct.unitPrice, 13.66);
assert.notEqual(anotherProduct.subtotal, branded.subtotal);

const visibleConfiguration = (value) =>
  value.replace(/[\u200B\u200C\u2063]/g, "");
assert.equal(
  visibleConfiguration(
    configuredSelectionLabel({
      brandingName: "Rotary Digital Print",
      packagingName: "Standard Packaging",
      quantity: 25,
    }),
  ),
  "Branding - Rotary Digital Print | Packaging - Standard Packaging",
);
assert.equal(
  visibleConfiguration(configuredSelectionLabel({ quantity: 25 })),
  "Unbranded",
  "unbranded configuration must hide its internal quantity identity",
);

assert.deepEqual(standardPackagingSelection("standard"), {
  id: "standard",
  name: "Standard Packaging",
});
assert.deepEqual(standardPackagingSelection("standard packaging"), {
  id: "standard",
  name: "Standard Packaging",
});
assert.equal(standardPackagingSelection("15915"), null);

console.log("Final total pricing regression checks passed.");
