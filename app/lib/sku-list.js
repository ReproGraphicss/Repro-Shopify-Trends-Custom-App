export function parseProductCodes(input) {
  const codes = input.replace(/^\uFEFF/, "").split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean)
    .filter((value, index) => !(index === 0 && /^(sku|product_?code|code)$/i.test(value)));
  const unique = [...new Set(codes)];
  return { valid: unique.filter((code) => /^\d{6}$/.test(code)), invalid: unique.filter((code) => !/^\d{6}$/.test(code)) };
}
