const clean = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const stockRows = (product) =>
  (Array.isArray(product?.stock) ? product.stock : [])
    .map((row) => ({
      sku: clean(row?.sku || row?.stock_code || row?.code || row?.product_code),
      name: clean(row?.description || row?.name || row?.colour || row?.color),
      data: Object.fromEntries(
        Object.entries(row || {})
          .filter(([, value]) =>
            ["string", "number", "boolean"].includes(typeof value),
          )
          .map(([key, value]) => [key, clean(value)])
          .filter(([, value]) => value),
      ),
    }))
    .filter((row) => row.sku && row.name);

export const VARIANT_AI_MASTER_PROMPT = `You are a cautious product-data analyst for a Shopify supplier integration.

Your task is to find customer-selectable option types that the deterministic rules have not already classified.

Rules:
1. Analyse only the supplied unbranded stock variants. Never use branding, decoration, print method, setup, pricing, packaging, inventory quantity, or marketing copy as a variant option.
2. Never invent a value. Every suggested value must be directly supported by a supplied variant row.
3. Every returned SKU must be copied exactly from the input and must belong to the value you assign.
4. Do not suggest an option already listed in existingOptionTypes, including synonyms.
5. An option is useful only when it has at least two distinct customer-selectable values across the supplied rows.
6. Compound values may be valid. Preserve their meaning and do not split them unless the row text clearly represents separate independent choices.
7. A row may legitimately have no value for an option. Do not force a match. This supports dependent Shopify selectors.
8. Use stable snake_case keys and short customer-friendly option names.
9. Return an empty options array when evidence is insufficient.
10. Confidence must reflect evidence in the supplied data, not general product knowledge.

The response must conform exactly to the provided JSON schema.`;

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          name: { type: "string" },
          confidence: { type: "number" },
          matches: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                sku: { type: "string" },
                value: { type: "string" },
              },
              required: ["sku", "value"],
            },
          },
        },
        required: ["key", "name", "confidence", "matches"],
      },
    },
  },
  required: ["options"],
};

const responseText = (response) =>
  response.output_text ||
  (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");

export async function classifyProductVariantsWithAi({
  apiKey,
  model = "gpt-5-mini",
  product,
  existingOptionTypes = [],
}) {
  const rows = stockRows(product);
  if (rows.length < 2) return null;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        {
          role: "system",
          content: VARIANT_AI_MASTER_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            product: {
              code: clean(product?.code),
              name: clean(product?.name),
            },
            existingOptionTypes: existingOptionTypes.map((type) => ({
              key: clean(type?.key),
              name: clean(type?.name),
              aliases: Array.isArray(type?.aliases)
                ? type.aliases.map(clean)
                : [],
            })),
            unbrandedVariants: rows,
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "variant_classification",
          strict: true,
          schema,
        },
      },
    }),
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(json?.error?.message || "OpenAI classification failed");
  const parsed = JSON.parse(responseText(json) || "{}");
  const validSkus = new Set(rows.map((row) => row.sku));
  const options = (parsed.options || [])
    .map((option) => {
      const matches = (option.matches || [])
        .map((match) => ({ sku: clean(match.sku), value: clean(match.value) }))
        .filter((match) => validSkus.has(match.sku) && match.value);
      const values = [...new Set(matches.map((match) => match.value))];
      const key = clean(option.key || option.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      return {
        key,
        name: clean(option.name),
        confidence: Math.max(0, Math.min(1, Number(option.confidence) || 0)),
        values,
        displayValues: Object.fromEntries(
          values.map((value) => [value, value]),
        ),
        matches,
        source: "ai",
        manual: true,
      };
    })
    .filter((option) => option.key && option.name && option.values.length > 1);
  return {
    status: "pending_review",
    source: "ai",
    model,
    generatedAt: new Date().toISOString(),
    options,
  };
}
