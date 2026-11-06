export const SHOPIFY_VARIANT_LIMIT = 2048;
export const MANAGED_CORE_VARIANT_TARGET = 1900;

export const planManagedCoreVariants = ({
  desiredVariants,
  existingVariants,
  managedSkuPrefix = "CFG-CORE-",
  productVariantLimit = SHOPIFY_VARIANT_LIMIT,
  managedVariantTarget = MANAGED_CORE_VARIANT_TARGET,
}) => {
  const nonManagedVariants = existingVariants.filter(
    (variant) => !String(variant.sku || "").startsWith(managedSkuPrefix),
  );
  const availableManagedSlots = Math.max(
    0,
    productVariantLimit - nonManagedVariants.length,
  );
  const targetVariants = desiredVariants.slice(
    0,
    Math.min(managedVariantTarget, availableManagedSlots),
  );
  const targetKeys = new Set(targetVariants.map((variant) => variant.key));
  const retainedManagedKeys = new Set();
  const staleManagedVariantIds = [];

  for (const variant of existingVariants) {
    if (!String(variant.sku || "").startsWith(managedSkuPrefix)) continue;
    if (!targetKeys.has(variant.key) || retainedManagedKeys.has(variant.key)) {
      staleManagedVariantIds.push(variant.id);
      continue;
    }
    retainedManagedKeys.add(variant.key);
  }

  const staleIds = new Set(staleManagedVariantIds);
  return {
    targetVariants,
    staleManagedVariantIds,
    retainedExistingVariants: existingVariants.filter(
      (variant) => !staleIds.has(variant.id),
    ),
    nonManagedVariantCount: nonManagedVariants.length,
    availableManagedSlots,
  };
};

export const planSafeVariantDeletionPhases = ({
  existingVariants,
  staleVariantIds,
}) => {
  const existingIds = new Set(
    (existingVariants || []).map((variant) => variant.id).filter(Boolean),
  );
  const staleIds = [
    ...new Set(
      (staleVariantIds || []).filter((variantId) => existingIds.has(variantId)),
    ),
  ];
  const wouldDeleteEveryVariant =
    existingIds.size > 0 && staleIds.length >= existingIds.size;
  const afterCreate = wouldDeleteEveryVariant ? staleIds.slice(-1) : [];
  const deferredIds = new Set(afterCreate);
  return {
    beforeCreate: staleIds.filter((variantId) => !deferredIds.has(variantId)),
    afterCreate,
  };
};
