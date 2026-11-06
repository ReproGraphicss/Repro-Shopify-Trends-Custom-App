export const DEFAULT_VARIANT_TYPES = [
  { key: "colour", name: "Colour", aliases: ["colour", "color"] },
  { key: "size", name: "Size", aliases: ["size", "sizing"] },
  { key: "material", name: "Material", aliases: ["material", "fabric"] },
  {
    key: "capacity",
    name: "Capacity / Weight",
    aliases: ["capacity", "volume", "weight", "ml", "litre", "gram"],
  },
  { key: "finish", name: "Finish", aliases: ["finish", "coating", "texture"] },
  {
    key: "ink_colour",
    name: "Ink colour",
    aliases: ["ink", "ink colour", "ink color"],
  },
  { key: "shape", name: "Shape", aliases: ["shape"] },
  {
    key: "style",
    name: "Style / Design",
    aliases: ["style", "design", "pattern", "character"],
  },
  { key: "fit", name: "Fit", aliases: ["fit"] },
  { key: "scent", name: "Scent", aliases: ["scent", "fragrance"] },
].map((item) => ({ ...item, enabled: true }));

const clean = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
const list = (value) => {
  if (Array.isArray(value)) return value.flatMap(list).filter(Boolean);
  if (value && typeof value === "object")
    return list(
      value.name ||
        value.value ||
        value.description ||
        value.colour ||
        value.color ||
        value.size ||
        value.material,
    );
  return clean(value).split(/[,;|]/).map(clean).filter(Boolean);
};
const unique = (values) => [...new Set(values.map(clean).filter(Boolean))];
const optionValue = (value) => clean(value).replace(/[.]+$/, "");
const containsOptionValue = (text, value) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
};
const stockRows = (product) =>
  (Array.isArray(product?.stock) ? product.stock : [])
    .map((row) => ({
      sku: clean(row?.sku || row?.stock_code || row?.code || row?.product_code),
      name: clean(row?.description || row?.name || row?.colour || row?.color),
    }))
    .filter((row) => row.sku || row.name);

export function parseVariantTypes(value) {
  try {
    const parsed =
      typeof value === "string" ? JSON.parse(value || "[]") : value;
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_VARIANT_TYPES;
    return parsed
      .map((item, index) => ({
        key: clean(item.key || item.name || `variant_${index + 1}`)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_"),
        name: clean(item.name),
        aliases: unique(list(item.aliases)),
        values: unique(list(item.values)),
        enabled: item.enabled !== false,
      }))
      .filter(
        (item) => item.name && item.key !== "other" && item.key !== "others",
      );
  } catch {
    return DEFAULT_VARIANT_TYPES;
  }
}

const PATTERNS = {
  colour:
    /\b(?:heather grey|heather gray|royal blue|slate blue|light blue|dark blue|sky blue|navy blue|bright green|dark green|light green|forest green|lime green|natural|white|black|grey|gray|red|orange|yellow|green|blue|purple|violet|pink|navy|aqua|teal|turquoise|charcoal|graphite|olive|khaki|beige|cream|ecru|brown|maroon|burgundy|gold|silver|clear|transparent)\b/gi,
  size: /\b(?:\d+XL|XXS|XS|S|M|L|XL|XXL|XXXL|\d+(?:\.\d+)?\s*(?:mm|cm|m))\b/gi,
  capacity: /\b\d+(?:\.\d+)?\s*(?:ml|l|litre|liter|g|kg|oz)\b/gi,
  material:
    /\b(?:cotton|organic cotton|polyester|recycled polyester|nylon|canvas|leather|faux leather|microfibre|microfiber|bamboo|wood|stainless steel|aluminium|aluminum|glass|ceramic|silicone|rubber|plastic|paper|cardboard|cork|wool|acrylic)\b/gi,
  finish:
    /\b(?:matte|matt|gloss|glossy|satin|frosted|clear|metallic|natural|polished|brushed)\b/gi,
  ink_colour: /\b(?:black|blue|red|green|white)\s+ink\b/gi,
  shape: /\b(?:round|square|rectangle|rectangular|oval|hexagonal)\b/gi,
  fit: /\b(?:regular|slim|relaxed|classic|unisex)\s+fit\b/gi,
  scent:
    /\b(?:vanilla|lavender|lemon|lime|orange|rose|jasmine|peppermint|mint|eucalyptus|coconut|sandalwood|cinnamon|unscented)\b/gi,
};

const residualVariantValue = (source) =>
  optionValue(
    source
      .replace(PATTERNS.ink_colour, " ")
      .replace(PATTERNS.finish, " ")
      .replace(PATTERNS.material, " ")
      .replace(PATTERNS.size, " ")
      .replace(PATTERNS.capacity, " ")
      .replace(PATTERNS.shape, " ")
      .replace(PATTERNS.fit, " ")
      .replace(PATTERNS.scent, " ")
      .replace(/[()[\]{}]/g, " ")
      .replace(/\s*[/|,+-]\s*/g, " ")
      .replace(/\s+/g, " "),
  );

const usableResidualValue = (value) => {
  const words = clean(value).split(/\s+/).filter(Boolean);
  return (
    value.length > 0 &&
    value.length <= 80 &&
    words.length <= 4 &&
    !/^\d+(?:\.\d+)?$/.test(value)
  );
};
const patternTest = (pattern, value) =>
  new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value);

// Variant options must come from supplier stock rows only. Product-level fields
// also contain branding, decoration, packaging and pricing metadata and are not
// safe sources for storefront variants.
function detectRowValues(rows, type, previousOption) {
  const normalizedAliases = new Set(
    [type.name, ...(type.aliases || [])].map((value) =>
      clean(value).toLowerCase(),
    ),
  );
  const compatibleBuiltIn = DEFAULT_VARIANT_TYPES.find((candidate) =>
    [candidate.name, ...(candidate.aliases || [])].some((value) =>
      normalizedAliases.has(clean(value).toLowerCase()),
    ),
  );
  const patternKey = PATTERNS[type.key] ? type.key : compatibleBuiltIn?.key;
  const pattern = PATTERNS[patternKey];
  const isInkColour = patternKey === "ink_colour";
  const isManual = type.manual === true || previousOption?.manual === true;
  const configuredValues = unique([
    ...(type.values || []),
    ...(isManual ? previousOption?.values || [] : []),
  ]).map(optionValue);
  const hasCompoundColourRows =
    patternKey === "colour" &&
    rows.some((row) => {
      const withoutInk = row.name.replace(PATTERNS.ink_colour, " ");
      return (
        withoutInk.includes("/") &&
        unique((withoutInk.match(PATTERNS.colour) || []).map(optionValue))
          .length > 1
      );
    });
  const recognisedColourRows =
    patternKey === "colour"
      ? rows.filter((row) => {
          const withoutInk = row.name.replace(PATTERNS.ink_colour, " ");
          return (withoutInk.match(PATTERNS.colour) || []).length > 0;
        }).length
      : 0;
  const hasColourFamily =
    patternKey === "colour" &&
    rows.length > 1 &&
    recognisedColourRows / rows.length >= 0.5;
  const colourDescriptors =
    patternKey === "colour"
      ? Object.entries(
          rows.reduce((counts, row) => {
            const colourSource = row.name.replace(PATTERNS.ink_colour, " ");
            const knownColours = colourSource.match(PATTERNS.colour) || [];
            if (!knownColours.length) return counts;
            const descriptor = optionValue(
              residualVariantValue(colourSource)
                .replace(PATTERNS.colour, " ")
                .replace(/\s+/g, " "),
            );
            if (descriptor && clean(descriptor).split(/\s+/).length <= 3) {
              counts[descriptor.toLowerCase()] =
                (counts[descriptor.toLowerCase()] || 0) + 1;
            }
            return counts;
          }, {}),
        )
          .filter(([, count]) => count >= 2)
          .map(([descriptor]) => descriptor)
          .sort((a, b) => b.length - a.length)
      : [];

  return rows
    .map((row) => {
      let source = row.name;
      if (patternKey === "colour") {
        source = source.replace(PATTERNS.ink_colour, " ");
      }
      const patternMatches = pattern ? source.match(pattern) || [] : [];
      const detected = unique([
        ...patternMatches.map((value) =>
          isInkColour ? value.replace(/\s+ink$/i, "") : value,
        ),
        ...configuredValues.filter((value) =>
          containsOptionValue(source, isInkColour ? `${value} ink` : value),
        ),
      ]).map(optionValue);
      if (patternKey === "colour" && !detected.length) {
        let residual = residualVariantValue(row.name);
        for (const descriptor of colourDescriptors) {
          const escaped = descriptor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          residual = optionValue(
            residual.replace(
              new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "i"),
              " ",
            ),
          );
        }
        const hasStructuredColourContext =
          patternTest(PATTERNS.ink_colour, row.name) ||
          patternTest(PATTERNS.finish, row.name) ||
          row.name.includes("/") ||
          hasCompoundColourRows ||
          hasColourFamily;
        if (hasStructuredColourContext && usableResidualValue(residual)) {
          detected.push(residual);
        }
      }
      const colourMatches = unique(patternMatches.map(optionValue));
      const standaloneVariant =
        patternKey === "colour" &&
        hasCompoundColourRows &&
        !source.includes("/") &&
        !/\b(?:black|blue|red|green|white)\s+ink\b/i.test(row.name) &&
        colourMatches.length > 0;
      const value = standaloneVariant
        ? row.name
        : patternKey === "colour" &&
            source.includes("/") &&
            colourMatches.length > 1
          ? colourMatches.join("/")
          : detected.sort((a, b) => b.length - a.length)[0];
      return value ? { sku: row.sku, value, sourceName: row.name } : null;
    })
    .filter(Boolean);
}

export function buildConfiguredVariant(product, typesInput, previous = {}) {
  const configuredTypes = parseVariantTypes(typesInput);
  const manualTypes = (previous.options || [])
    .filter(
      (option) =>
        option.manual === true &&
        !configuredTypes.some((type) => type.key === option.key),
    )
    .map((option) => ({
      key: option.key,
      name: option.name,
      aliases: option.aliases || [option.name],
      values: option.values || [],
      enabled: true,
      manual: true,
    }));
  const types = [...configuredTypes, ...manualTypes].filter(
    (type) => type.enabled,
  );
  const rows = stockRows(product);
  const options = [];
  for (const type of types) {
    const previousOption = (previous.options || []).find(
      (option) => option.key === type.key,
    );
    const automaticMatches = detectRowValues(rows, type, previousOption);
    const values = unique(automaticMatches.map((match) => match.value)).filter(
      (value) => value.length <= 80,
    );
    const isManual = type.manual === true || previousOption?.manual === true;
    const suppliedMatches = (isManual ? previousOption?.matches || [] : [])
      .map((match) => ({
        sku: clean(match?.sku),
        value: optionValue(match?.value),
        sourceName:
          clean(match?.sourceName) ||
          rows.find((row) => row.sku === clean(match?.sku))?.name ||
          "",
      }))
      .filter(
        (match) =>
          match.sku &&
          match.value &&
          values.includes(match.value) &&
          rows.some((row) => row.sku === match.sku),
      );
    const suppliedBySku = new Map(
      suppliedMatches.map((match) => [match.sku, match]),
    );
    const matches = [
      ...automaticMatches.filter((match) => !suppliedBySku.has(match.sku)),
      ...suppliedMatches,
    ];
    const usedValues = unique(matches.map((match) => match.value));
    const coverage = rows.length ? matches.length / rows.length : 0;
    const isConditionalSingleValue =
      usedValues.length === 1 && coverage > 0 && coverage < 1;
    if (
      (usedValues.length > 1 || isConditionalSingleValue) &&
      (isManual || coverage >= 0.65)
    ) {
      options.push({
        key: type.key,
        name: previousOption?.name || type.name,
        values: usedValues,
        displayValues: Object.fromEntries(
          usedValues.map((value) => [
            value,
            previousOption?.displayValues?.[value] || value,
          ]),
        ),
        matches,
        manual: isManual,
        source: previousOption?.source === "ai" ? "ai" : "normal",
      });
    }
  }

  // A supplier can mix normally structured variants with a standalone item,
  // for example "Metallic Red (Black Ink)" and "Natural Paper Pen Sleeve".
  // A generic word such as "Natural" may technically match more than one
  // detector, but that must not truncate the standalone variant name or make
  // unrelated selectors applicable to it. Keep its complete supplier name as
  // the primary value and remove secondary attributes for that SKU.
  const primaryOption =
    options.find((option) => option.key === previous.primaryOptionKey) ||
    options[0];
  const explicitlyStructuredRows = rows.filter((row) =>
    /[()[\]{}\/|,]/.test(row.name),
  ).length;
  const multiAttributeRows = rows.filter((row) => {
    const distinctValues = unique(
      options.flatMap((option) =>
        option.matches
          .filter((match) => match.sku === row.sku)
          .map((match) => match.value.toLowerCase()),
      ),
    );
    return distinctValues.length >= 2;
  }).length;
  const hasStructuredFamily =
    rows.length > 1 && explicitlyStructuredRows / rows.length >= 0.5;
  const hasMultiAttributeFamily =
    rows.length > 1 && multiAttributeRows / rows.length >= 0.5;
  const schemaCounts = rows.reduce((counts, row) => {
    const schema = options
      .filter((option) => option.matches.some((match) => match.sku === row.sku))
      .map((option) => option.key)
      .sort()
      .join("|");
    counts[schema] = (counts[schema] || 0) + 1;
    return counts;
  }, {});
  const dominantSchemaCount = Math.max(0, ...Object.values(schemaCounts));
  const hasHeterogeneousStandaloneFamily =
    rows.length > 1 &&
    explicitlyStructuredRows === 0 &&
    dominantSchemaCount / rows.length <= 0.5;
  const hasOnlyMirroredAttributes =
    rows.length > 1 &&
    explicitlyStructuredRows === 0 &&
    rows.every((row) => {
      const values = unique(
        options.flatMap((option) =>
          option.matches
            .filter((match) => match.sku === row.sku)
            .map((match) => match.value.toLowerCase()),
        ),
      );
      return values.length <= 1;
    });

  if (
    primaryOption &&
    (hasStructuredFamily ||
      hasMultiAttributeFamily ||
      hasHeterogeneousStandaloneFamily ||
      hasOnlyMirroredAttributes)
  ) {
    const fallbackSkus = new Set(
      rows
        .filter((row) => {
          if (hasHeterogeneousStandaloneFamily || hasOnlyMirroredAttributes)
            return true;
          if (/[()[\]{}\/|,]/.test(row.name)) return false;
          const matchedValues = unique(
            options.flatMap((option) =>
              option.matches
                .filter((match) => match.sku === row.sku)
                .map((match) => match.value.toLowerCase()),
            ),
          );
          const primaryMatch = primaryOption.matches.find(
            (match) => match.sku === row.sku,
          );
          return (
            primaryMatch &&
            matchedValues.length <= 1 &&
            clean(primaryMatch.value).toLowerCase() !==
              clean(row.name).toLowerCase()
          );
        })
        .map((row) => row.sku),
    );

    if (fallbackSkus.size) {
      for (const option of options) {
        if (option.key === primaryOption.key) {
          option.matches = option.matches.map((match) => {
            if (!fallbackSkus.has(match.sku)) return match;
            const row = rows.find((candidate) => candidate.sku === match.sku);
            return {
              ...match,
              value: row?.name || match.value,
              sourceName: row?.name || match.sourceName,
              fallback: true,
            };
          });
        } else {
          option.matches = option.matches.filter(
            (match) => !fallbackSkus.has(match.sku),
          );
        }
        option.values = unique(option.matches.map((match) => match.value));
        option.displayValues = Object.fromEntries(
          option.values.map((value) => [
            value,
            option.displayValues?.[value] || value,
          ]),
        );
      }
    }
  }

  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index].matches.length || !options[index].values.length) {
      options.splice(index, 1);
    }
  }

  const variants = rows.map((row) => {
    const attributes = Object.fromEntries(
      options
        .map((option) => [
          option.name,
          option.matches.find((match) => match.sku === row.sku)?.value,
        ])
        .filter(([, value]) => value),
    );
    return {
      sku: row.sku,
      fullName: row.name,
      attributes,
      applicableOptionKeys: options
        .filter((option) => attributes[option.name] !== undefined)
        .map((option) => option.key),
    };
  });
  return {
    version: 1,
    enabled: previous.enabled === true,
    primaryOptionKey: previous.primaryOptionKey || options[0]?.key || null,
    productCode: clean(product?.code),
    selection: {
      mode: "dependent",
      hideNonApplicableOptions: true,
      autoSelectSingleValue: true,
    },
    options,
    variants,
    ...(previous.aiSuggestion ? { aiSuggestion: previous.aiSuggestion } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function summarizeVariantMatches(products, typesInput) {
  const types = parseVariantTypes(typesInput);
  const summary = Object.fromEntries(types.map((type) => [type.key, []]));
  for (const row of products) {
    try {
      const previous = row.configuredVariantJson
        ? JSON.parse(row.configuredVariantJson)
        : {};
      const config = buildConfiguredVariant(
        JSON.parse(row.trendsDataJson || "{}"),
        types,
        previous,
      );
      for (const option of config.options)
        summary[option.key]?.push({
          id: row.id,
          sku: row.productCode,
          title: row.title || row.productCode,
          values: option.values,
          configured: Boolean(row.configuredVariantJson),
          enabled: Boolean(row.configuredVariantEnabled),
          configuration: row.configuredVariantJson
            ? JSON.parse(row.configuredVariantJson)
            : config,
        });
    } catch {
      /* Ignore malformed supplier records. */
    }
  }
  return summary;
}
