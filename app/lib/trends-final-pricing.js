export function calculateFinalPricing({
  baseUnitPrice,
  quantity,
  additionalCosts = [],
  fixedShippingAmount = 15,
  markupPercent = 0,
}) {
  const itemQuantity = Math.max(1, Math.trunc(Number(quantity) || 1));
  const basePrice = Number(baseUnitPrice || 0);
  const shippingCharge = Number(fixedShippingAmount || 0);
  const brandingUnitPrice = Number(
    additionalCosts
      .filter((item) => item.mode === "branding")
      .reduce((total, item) => total + Number(item.unitPrice || 0), 0)
      .toFixed(2),
  );
  const packagingUnitPrice = Number(
    additionalCosts
      .filter((item) => item.mode === "gift_ready")
      .reduce((total, item) => total + Number(item.unitPrice || 0), 0)
      .toFixed(2),
  );
  const setupPrice = Number(
    additionalCosts
      .reduce((total, item) => total + Number(item.setupPrice || 0), 0)
      .toFixed(2),
  );
  const rawSubtotal = Number(
    (
      basePrice * itemQuantity +
      additionalCosts.reduce(
        (total, item) =>
          total +
          Number(item.unitPrice || 0) * Number(item.quantity || itemQuantity) +
          Number(item.setupPrice || 0),
        0,
      ) +
      shippingCharge
    ).toFixed(2),
  );
  const markupAmount = Number(
    (rawSubtotal * (Number(markupPercent || 0) / 100)).toFixed(2),
  );
  const subtotal = Number((rawSubtotal + markupAmount).toFixed(2));
  return {
    baseUnitPrice: basePrice,
    brandingUnitPrice,
    packagingUnitPrice,
    setupPrice,
    shippingCharge,
    rawSubtotal,
    markupPercent: Number(markupPercent || 0),
    markupAmount,
    subtotal,
    unitPrice: Number((subtotal / itemQuantity).toFixed(2)),
  };
}
