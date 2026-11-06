import assert from "node:assert/strict";
import fs from "node:fs";

import {
  isPackagingCost,
  packagingDisplayName,
} from "../app/lib/trends-cost-classification.js";

const trendsFixturePath =
  "C:/Users/WTS-LAP-180/.codex/attachments/a3c95f49-8d08-4086-9118-cbde75981821/Pasted text.txt";
const trendsPayload = JSON.parse(fs.readFileSync(trendsFixturePath, "utf8"));
const product = trendsPayload.data[0];

assert.equal(
  isPackagingCost({
    type: "DO",
    branding_option: "Faux Embroidery",
    branding_area: "Sleeve - 420mm x 80mm",
    description: "Faux Embroidery Per Position",
  }),
  false,
  "a garment sleeve decoration must remain a branding cost",
);
assert.equal(
  isPackagingCost({ type: "OE", description: "Individual Polybag" }),
  true,
  "an optional polybag must be classified as packaging",
);
assert.equal(
  packagingDisplayName({
    name: "Individual Polybag",
    description: "Individual Polybag",
  }),
  "Individual Polybag",
  "paid packaging must retain its source name instead of becoming a gift box",
);
assert.equal(
  packagingDisplayName({ description: "Mailing Tube" }),
  "Mailing Tube",
  "packaging descriptions should be used when a source name is unavailable",
);
assert.equal(
  packagingDisplayName({}),
  "Optional Packaging",
  "unnamed packaging should use a neutral fallback",
);

const additionalCosts = [
  ...new Map(
    product.pricing
      .flatMap((tier) => tier.additional_costs || [])
      .map((cost, index) => [String(cost.id ?? index), cost]),
  ).entries(),
];
const packagingEntries = additionalCosts.filter(([, cost]) =>
  isPackagingCost(cost),
);
assert.deepEqual(
  packagingEntries.map(([costKey]) => costKey),
  ["6919"],
  "only the Individual Polybag entry should be packaging for product 121132",
);
assert.ok(
  additionalCosts
    .filter(([, cost]) => /sleeve/i.test(cost.branding_area || ""))
    .every(([, cost]) => !isPackagingCost(cost)),
  "all sleeve decoration areas must remain branding entries",
);

console.log("Packaging classification regression checks passed.");
