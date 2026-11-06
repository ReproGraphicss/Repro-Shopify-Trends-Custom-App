export const isPackagingCost = (cost) => {
  const costType = String(cost?.type || "").trim().toUpperCase();
  // TRENDS uses DO/DS for decoration charges. A decoration area can contain
  // words such as "Sleeve", which describes the garment location rather than
  // packaging and must not be exposed as a gift-packaging option.
  if (costType === "DO" || costType === "DS") return false;

  const packagingDescription = `${cost?.description || ""} ${cost?.name || ""} ${cost?.title || ""} ${cost?.label || ""} ${cost?.additional_cost_description || ""} ${cost?.cost_description || ""}`;
  return /gift\s*(?:box|bag|pack|wrap)|packag|poly\s*bag|pouch|presentation\s*box|carton|mailing\s*tube/i.test(
    packagingDescription,
  );
};

export const packagingDisplayName = (method) => {
  const sourceName = String(
    method?.name || method?.description || method?.area || "",
  ).trim();

  return sourceName || "Optional Packaging";
};
