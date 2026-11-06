import assert from "node:assert/strict";

import {
  planManagedCoreVariants,
  planSafeVariantDeletionPhases,
} from "../app/lib/trends-variant-capacity.js";

const desiredVariants = Array.from({ length: 2992 }, (_, index) => ({
  key: `desired-${index}`,
}));
const retainedCore = Array.from({ length: 1200 }, (_, index) => ({
  id: `core-${index}`,
  sku: `CFG-CORE-121132-${index}`,
  key: `desired-${index}`,
}));
const obsoleteCore = Array.from({ length: 700 }, (_, index) => ({
  id: `obsolete-${index}`,
  sku: `CFG-CORE-121132-OLD-${index}`,
  key: `obsolete-${index}`,
}));
const onDemandVariants = Array.from({ length: 200 }, (_, index) => ({
  id: `custom-${index}`,
  sku: `CFG-TEMP-121132-${index}`,
  key: `custom-${index}`,
}));

const plan = planManagedCoreVariants({
  desiredVariants,
  existingVariants: [...retainedCore, ...obsoleteCore, ...onDemandVariants],
});

assert.equal(plan.nonManagedVariantCount, 200);
assert.equal(plan.availableManagedSlots, 1848);
assert.equal(plan.targetVariants.length, 1848);
assert.equal(plan.staleManagedVariantIds.length, 700);
assert.equal(
  plan.retainedExistingVariants.length +
    plan.targetVariants.filter(
      (variant) =>
        !plan.retainedExistingVariants.some(
          (existing) => existing.key === variant.key,
        ),
    ).length,
  2048,
  "cleanup plus creation must stay within Shopify's product variant limit",
);
assert.ok(
  onDemandVariants.every((variant) =>
    plan.retainedExistingVariants.some(
      (existing) => existing.id === variant.id,
    ),
  ),
  "on-demand variants must be preserved",
);

assert.deepEqual(
  planSafeVariantDeletionPhases({
    existingVariants: [{ id: "only-variant" }],
    staleVariantIds: ["only-variant"],
  }),
  { beforeCreate: [], afterCreate: ["only-variant"] },
  "the last existing variant must remain until its replacement is created",
);

assert.deepEqual(
  planSafeVariantDeletionPhases({
    existingVariants: [{ id: "keep" }, { id: "stale" }],
    staleVariantIds: ["stale"],
  }),
  { beforeCreate: ["stale"], afterCreate: [] },
  "ordinary stale variants can be removed before creation",
);

console.log("Variant capacity and obsolete-core cleanup checks passed.");
