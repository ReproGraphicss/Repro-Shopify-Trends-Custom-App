export function configuredSelectionLabel({
  brandingName,
  packagingName,
  quantity,
}) {
  return [
    brandingName ? `Branding - ${brandingName}` : null,
    packagingName ? `Packaging - ${packagingName}` : null,
  ]
    .filter(Boolean)
    .join(" | ") || "Unbranded";
}

export function standardPackagingSelection(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  return ["standard", "standard-packaging", "included"].includes(normalized)
    ? { id: "standard", name: "Standard Packaging" }
    : null;
}
